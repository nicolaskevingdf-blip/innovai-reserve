# Innovai Reserve — Arquitetura

## 1. Visão geral

```
 Navegador (React SPA, mobile-first)
   ├── Painel do estabelecimento  ── supabase-js (JWT do usuário) ──┐
   ├── Página pública /restaurante/:slug ── supabase-js (anon) ──┐  │
   └── Consulta /reserva/:codigo ─────────────────────────────────┤  │
                                                                  ▼  ▼
                                    Supabase ─ PostgREST ─ Postgres (RLS + RPCs)
                                             ─ Auth (e-mail/senha)
                                             ─ Realtime (reservas, bloqueios, notificações)
                                             ─ Storage (bucket tenant-assets)
                                             ─ Edge Function notification-dispatcher → Resend / WhatsApp Cloud API
```

**Decisão central:** as regras de negócio críticas vivem **no banco** (constraints, triggers e funções), não no frontend. Assim, qualquer caminho de escrita — página pública, painel, futura API, app mobile, integração — obedece às mesmas regras e não existe como “furar” a agenda chamando a API direto.

## 2. Multiempresa (multi-tenant)

- Modelo **banco compartilhado, `tenant_id` em todas as tabelas de negócio**. É o modelo que escala para centenas de clientes com custo baixo e um único deploy.
- **Isolamento por RLS** em todas as tabelas. As políticas usam funções `SECURITY DEFINER` (`is_member`, `is_manager`, `can_write`, `can_manage`) que consultam `tenant_members` para o `auth.uid()` atual.
- **FKs compostas `(tenant_id, id)`**: uma reserva não consegue apontar para cliente, serviço, profissional ou mesa de outra empresa, mesmo que alguém descubra o UUID (testado).
- **Visitantes anônimos não têm acesso a nenhuma tabela.** A página pública usa apenas RPCs específicas (`get_public_page`, `get_available_slots`, `create_public_reservation`, …) que expõem só campos públicos.
- `EXECUTE` em funções internas é revogado de `anon`/`authenticated`; só as RPCs públicas são liberadas explicitamente.
- Estabelecimento **suspenso** continua podendo ler (para ver o aviso), mas não escreve (`can_write`).
- Status comercial e plano só podem ser alterados por administradores Innovai (trigger `tenants_guard`).
- Sempre há ao menos um proprietário ativo (constraint trigger diferida).
- Alterações de configuração e equipe vão para `audit_logs`.

### Papéis

| Papel | Escopo |
| --- | --- |
| Administrador Innovai (`platform_admins`) | Todas as empresas (base para o painel da Fase 4) |
| Proprietário | Tudo no próprio estabelecimento, inclusive equipe e proprietários |
| Gerente | Configurações, horários, equipe (exceto proprietários), exclusões |
| Funcionário | Agenda, reservas, clientes e bloqueios; configurações somente leitura. `tenant_members.permissions` (jsonb) está pronto para permissões granulares |
| Cliente final | Sem conta: reserva com nome + telefone; consulta/cancela/remarca com código + telefone. `customers.user_id` está pronto para contas de cliente |

## 3. Banco de dados

| Domínio | Tabelas |
| --- | --- |
| Plataforma | `plans`, `subscriptions`, `platform_admins`, `profiles` |
| Empresa | `tenants`, `tenant_members`, `tenant_invitations`, `booking_settings`, `business_hours`, `notification_settings` |
| Agenda | `reservations`, `reservation_events` (histórico imutável), `schedule_blocks`, `waitlist_entries`, `reservation_tables` (ocupação por mesa) |
| CRM | `customers`, view `customer_stats` (`security_invoker`) |
| Salão (Fase 2) | `areas`, `dining_tables`, `table_combinations` |
| Profissionais (Fase 3) | `staff`, `staff_hours`, `services`, `service_staff` |
| Operação | `notifications` (inbox interna + outbox externa), `audit_logs` |
| Comercial (Fase 4) | `plans`, `subscriptions`, `platform_admins`, `support_tickets`, `support_messages` |

Todos os instantes são `timestamptz` (UTC). Cada empresa tem `timezone` (IANA) e toda conversão de “dia/hora local” acontece com esse fuso, no banco (`AT TIME ZONE`) e no frontend (`date-fns-tz`) — nunca com o fuso do navegador.

## 4. Regras de negócio da agenda

### Disponibilidade (`_compute_slots`)
Um horário só é oferecido se **todas** as condições forem verdadeiras:
1. Está dentro de um turno de `business_hours` do dia da semana local e a reserva **termina** até o fim do turno.
2. Está na grade `slot_interval_min` a partir da abertura do turno.
3. Respeita antecedência mínima (`min_advance_min`) e máxima (`max_advance_days`).
4. Não colide com `schedule_blocks` do estabelecimento.
5. Capacidade: reservas ativas sobrepostas (considerando `buffer_min` entre reservas) `< max_reservations_per_slot` **e** pessoas sobrepostas + grupo `≤ max_guests_per_slot`.
6. Tamanho do grupo dentro de `min_party_size..max_party_size`.

### Prevenção de conflitos e duplicidade — três camadas
1. **Revalidação na confirmação:** `create_public_reservation` adquire um *advisory lock* por empresa (`pg_advisory_xact_lock`) e recalcula a disponibilidade **dentro da mesma transação** antes de inserir. Se o horário acabou de ser tomado, o cliente recebe “Este horário acabou de ficar indisponível” e a lista é recarregada.
2. **Trigger `reservations_before_write`** em *toda* escrita (painel, API, remarcação): pega o mesmo lock e revalida bloqueios e capacidade. Reservas manuais podem sair da grade de horários, mas nunca ultrapassam capacidade nem invadem bloqueios.
3. **Exclusion constraints (GiST)** no Postgres, impossíveis de burlar mesmo com bugs na aplicação:
   - mesmo **cliente** (telefone normalizado) com reservas ativas sobrepostas na mesma empresa;
   - mesma **mesa** com reservas sobrepostas (Fase 2);
   - mesmo **profissional** com atendimentos sobrepostos (Fase 3).

Teste de concorrência: 15 requisições simultâneas pelo último lugar → exatamente 1 reserva criada, 14 recusadas.

### Restaurante: alocação por mesa (Fase 2)
Ativada em *Regras de reserva → Reservar por mesa* (`booking_settings.allocation_mode = 'tables'`).
- Cada reserva ocupa 1..n mesas (`reservations.table_ids`). O espelho `reservation_tables` guarda o período **incluindo o intervalo de limpeza** e tem uma *exclusion constraint* por mesa: duas reservas nunca ocupam a mesma mesa ao mesmo tempo, nem dentro de uma união.
- **Melhor encaixe:** `_find_tables` escolhe a menor mesa ativa com `min_capacity ≤ grupo ≤ max_capacity`, livre e sem bloqueio; só se nenhuma servir, usa a menor **união de mesas** configurada cujas mesas estejam todas livres. A capacidade mínima impede que um casal ocupe a mesa de 8.
- **Ambiente preferido:** a busca de horários e a alocação respeitam o ambiente escolhido pelo cliente (filtro estrito; “Sem preferência” considera todos).
- **Disponibilidade = existe mesa livre** para o grupo naquele horário (além de horários, bloqueios, antecedência e o limite opcional de pessoas simultâneas da cozinha).
- A equipe pode escolher mesas manualmente; mesa ocupada é recusada (`TABLE_TAKEN`). Ao remarcar ou aumentar o grupo, a mesa é mantida se ainda servir; senão o sistema realoca, ou recusa (`NO_TABLE`).
- Mesas com reservas futuras não podem ser excluídas (apenas desativadas).
- Status do mapa num instante: **cinza** inativa/bloqueada · **vermelho** cliente sentado (check-in) · **azul** reserva cobrindo o instante ou começando em até 30 min · **amarelo** reserva mais tarde no dia · **verde** livre.
- **Lista de espera:** o cliente entra pela página pública quando o dia/horário está lotado (máx. 3 pedidos ativos por telefone). Cancelamentos avisam a equipe em tempo real quando há gente esperando naquele dia; “Avisar” enfileira WhatsApp/e-mail (ou abre o WhatsApp com a mensagem pronta) e “Criar reserva” converte o pedido.
- Ocupação do salão no dashboard = minutos-mesa reservados ÷ (minutos abertos × mesas ativas).

### Barbearia e serviços: agenda por profissional (Fase 3)
Ativada em *Regras de reserva → Por profissional* (`allocation_mode = 'staff'`) ou pelo botão “Ativar agora” em Serviços/Profissionais.
- **Duração = duração do serviço.** O **preparo** do serviço (+ intervalo geral) bloqueia o profissional depois do atendimento (`reservations.occupied_until`), sem aparecer para o cliente.
- **Garantia no banco:** *exclusion constraint* em `(staff_id, [início, occupied_until))` — um profissional nunca tem dois atendimentos sobrepostos, nem invadindo o preparo.
- **Quem pode atender:** profissionais vinculados ao serviço (`service_staff`); serviço sem vínculo pode ser feito por qualquer um.
- **Quando trabalha:** horário próprio (`staff_hours`, vários turnos por dia = intervalo de almoço); sem horário próprio, segue o do estabelecimento. O atendimento precisa caber inteiro no turno. Folgas, férias e intervalos pontuais são bloqueios com `staff_id`.
- **Disponibilidade:** um horário aparece se existe ao menos um profissional qualificado, trabalhando, sem atendimento/preparo/bloqueio. Com profissional escolhido, só a agenda dele conta.
- **“Qualquer profissional”:** `_find_staff` escolhe quem tem menos atendimentos no dia (agenda equilibrada), depois a ordem cadastrada. A reserva guarda `staff_requested = false`; numa remarcação o sistema pode trocar de profissional. Se o cliente escolheu alguém, a remarcação só oferece horários desse profissional.
- Equipe: escolher um profissional ocupado é recusado (`STAFF_BUSY`); sem ninguém livre, `NO_STAFF`. Reservas manuais podem ficar fora da grade/turno, mas nunca sobrepõem atendimentos ou bloqueios.
- **Agenda individual:** visão do dia em colunas por profissional (turnos destacados, preparo visível) e filtro por profissional; quem tem login vinculado ao cadastro abre direto em “Minha agenda”.
- **Métricas** (`staff_service_metrics`): atendimentos, concluídos, faltas e receita por profissional; ranking de serviços; ocupação = minutos atendidos ÷ minutos de trabalho dos profissionais.

### SaaS comercial (Fase 4)
- **Planos** (`plans.limits` / `plans.features`) e **exceções por cliente** (`tenants.feature_overrides`) formam os limites e funcionalidades efetivos (`tenant_limits`, `tenant_features`).
- **Aplicação no banco** (não só na tela): usuários + convites (`max_members`), mesas + profissionais (`max_resources`), reservas criadas no mês no fuso do estabelecimento (`max_reservations_month`), modos por mesa/profissional (`tables_map`) e WhatsApp (`whatsapp`). Erros com `hint` `PLAN_LIMIT` ou `FEATURE_LOCKED`. Administradores Innovai e jobs do sistema não são bloqueados.
- **Teste:** todo estabelecimento novo começa com 14 dias do plano Pro. Quando a Innovai cria a empresa, o plano vendido é mantido durante o teste.
- **Ciclo de vida:** `subscription_ok` = ativa, em teste dentro do prazo, ou pendente há menos de 7 dias. Fora disso, reservas online param. `refresh_subscription_states()` (diário) passa testes vencidos para *pendente* e pendências antigas para *suspenso* — o estabelecimento fica somente leitura e sai do ar publicamente. Reativar a assinatura reabre tudo.
- **Campos comerciais** (plano, status, exceções, domínio, notas internas) só mudam pela Innovai (`tenants_guard`).
- **Painel Innovai:** RPCs `admin_*` exigem `platform_admins`; toda ação administrativa vai para `audit_logs`.
- **Suporte:** `support_tickets` + `support_messages` com RLS por estabelecimento; só a equipe Innovai publica como “suporte” (`is_staff` é definido pelo banco). Resposta gera notificação em tempo real.
- **Cobrança:** `billing-webhook` sincroniza assinaturas do Stripe (status, período, plano por `metadata.plan_code`) e reabre estabelecimentos após pagamento.

### Ciclo de vida
`pending → confirmed → in_progress → completed`, com `cancelled` e `no_show`. Cada transição grava carimbo de tempo (`confirmed_at`, `checked_in_at`…) e um evento em `reservation_events` com autor (`staff`/`customer`/`system`) e diff dos campos. Remarcar preserva a duração. Excluir é restrito a gerentes (recomendado cancelar).

### Cliente final
- Sem cadastro: nome + telefone (+ e-mail opcional).
- Limite de reservas ativas por telefone (`max_active_per_phone`) contra abuso.
- Consulta por **código de 7 caracteres + telefone** (≈27 bilhões de combinações e o telefone precisa bater).
- Cancelamento/remarcação online até `cancellation_min_notice_min` antes, se habilitado.
- O CRM é alimentado automaticamente (upsert por telefone). Excluir um cliente desvincula as reservas e não é desfeito pelos triggers (pedido LGPD).

## 5. Notificações

- Triggers geram mensagens na tabela `notifications`:
  - **in_app** para a equipe (nova reserva online, cancelamento/remarcação pelo cliente), entregues em tempo real via Realtime;
  - **email/whatsapp** para o cliente quando o canal está ativo: recebida/confirmada, alterada, cancelada, **lembrete** (agendado para N horas antes e substituído ao remarcar), pedido de avaliação.
- `notification-dispatcher` (Edge Function) consome a fila com `claim_due_notifications` (`FOR UPDATE SKIP LOCKED`), envia pelo provedor e registra `sent` / `failed` (com retry) / `requires_setup`.

## 6. Frontend

- SPA com *code splitting* por página; gráficos em chunk separado.
- `AppShell`: sidebar no desktop; barra inferior com botão central “+” no celular.
- Dados via TanStack Query; **Realtime** invalida reservas, bloqueios, dashboard e notificações da empresa atual.
- Página pública usa a cor da marca do estabelecimento (`--brand-rgb`) e calcula texto legível automaticamente.
- Datas de exibição sempre no fuso da empresa.

## 7. Roadmap

| Fase | Entregas | Base já pronta |
| --- | --- | --- |
| **2 — Restaurante** ✅ | Editor visual do salão, ambientes, status por cor, uniões de mesas, alocação automática, lista de espera | Entregue |
| **3 — Barbearia** ✅ | Profissionais, serviços, agenda individual, “qualquer profissional” | Entregue |
| **4 — SaaS comercial** ✅ | Painel Innovai, planos/limites, assinaturas, suporte, cobrança | Entregue (cobrança automática depende da conta Stripe) |
| **5 — Inteligência** | Lembretes WhatsApp, relatórios avançados, IA | Outbox + despachante; `dashboard_metrics`, `customer_insights` |

### Camada de IA (Fase 5) — desenho
Para responder “Quais foram os horários mais movimentados esta semana?” **sem inventar números**:
1. O modelo (Claude) recebe apenas **ferramentas** que chamam funções SQL existentes e auditáveis (`dashboard_metrics`, `customer_insights` e novas como `staff_ranking`, `table_occupancy`), executadas com o JWT do usuário — logo, limitadas pela RLS da empresa.
2. O modelo nunca gera SQL livre nem recebe dados de outras empresas.
3. A resposta cita os números retornados pelas ferramentas; quando a ferramenta não tem o dado, a resposta diz que o dado não está disponível.
4. Execução numa Edge Function (`ai-assistant`) com chave da API guardada em secrets e limite de uso por plano (`plans.features.ai_insights`).

## 8. Limitações conhecidas da Fase 1

- Turnos que atravessam a meia-noite não são suportados (use dois turnos).
- Um agendamento tem um serviço e um profissional (combos são cadastrados como serviço próprio, ex.: “Corte + barba”). Uniões de mesas são definidas pelo gerente (o sistema não deduz mesas vizinhas pelo mapa).
- O mapa do salão usa uma área lógica de 1000×620; em celulares ele rola horizontalmente.
- Convites de equipe não enviam e-mail automaticamente (a pessoa entra com o e-mail convidado).
- O slug do link público é fixo após a criação (proteção de links divulgados).
- Domínio próprio é registrado pela Innovai; o apontamento DNS e o roteamento por domínio no provedor de hospedagem precisam ser configurados fora da plataforma.
- Os limites de plano são verificados a cada gravação; reduzir um plano não apaga dados que já excedem o novo limite (apenas impede novos cadastros).
