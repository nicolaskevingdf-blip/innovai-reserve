# Innovai Reserve

Plataforma SaaS multiempresa de reservas e agendamentos para restaurantes, barbearias, salões e qualquer negócio que trabalha com horários.

**Fase 5 (Inteligência e automação) entregue:** relatórios avançados (mapa dia × hora, faltas por dia, motivos de cancelamento, antecedência, ocupação por mesa e por profissional, clientes recorrentes, exportação CSV); recomendações calculadas no banco só com dados reais (pico, dia mais vazio, faltas, tendência, cancelamentos, clientes sumidos, reservas online); automações de reconquista e aniversário pela fila de mensagens, apenas para quem aceitou receber promoções; e um assistente de IA (Claude) que responde perguntas sobre os dados do estabelecimento usando ferramentas que rodam com as permissões do próprio usuário.

**Fase 4 (SaaS comercial) entregue:** Painel Innovai (`/admin`) com visão geral (MRR, empresas, testes terminando, reservas da plataforma), gestão de empresas (plano, status, assinatura, fim do teste, exceções de funcionalidades e limites, domínio próprio, notas internas), criação de cliente com convite do proprietário, edição de planos e central de suporte; limites e funcionalidades do plano aplicados no banco; ciclo de vida da assinatura (teste → pendente → suspenso); "Meu plano" com consumo; chamados de suporte; webhook de cobrança Stripe pronto.

**Fase 3 (Barbearia e serviços) entregue:** serviços com preço, duração e tempo de preparo; profissionais com foto, especialidade, cor, horário próprio (com intervalo de almoço), folgas/férias e serviços que realizam; agendamento online "escolha o profissional" ou "qualquer profissional" (distribuição equilibrada); agenda do dia em colunas por profissional e "Minha agenda" para quem tem login vinculado; métricas de atendimentos por profissional, serviços mais realizados, receita e ocupação.

**Fase 2 (Restaurante) entregue:** mapa visual do salão com arrastar e soltar, ambientes, mesas com capacidade mínima/máxima e formato, uniões de mesas para grupos, alocação automática por melhor encaixe (com ambiente preferido do cliente), status ao vivo por cor (disponível, reservada, ocupada, chegada aguardada, indisponível), sentar cliente sem reserva e liberar mesa, lista de espera (página pública + painel) e ocupação do salão por mesa.

**Fase 1 (MVP) entregue:** login, cadastro do estabelecimento, dashboard adaptado ao segmento, agenda (dia/semana/mês/lista), reservas, CRM de clientes, horários e turnos, regras de disponibilidade, bloqueios, página pública de reservas sem login, consulta/remarcação/cancelamento pelo cliente, equipe com papéis, notificações internas em tempo real, fila de notificações externas e segurança multiempresa no banco.

| Camada | Tecnologia |
| --- | --- |
| Frontend | React 18 · TypeScript · Vite · Tailwind CSS · TanStack Query · Recharts |
| Backend | Supabase: Postgres 15+/17, Auth, Row Level Security, RPCs em PL/pgSQL, Realtime, Storage, Edge Functions |

---

## Como rodar localmente

Pré-requisitos: Node 20+, Docker e a [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
npm install
```

```bash
npx supabase start
```

O comando acima aplica todas as migrations em `supabase/migrations`. Copie a `API URL` e a `anon key` que ele imprime para o `.env.local`:

```bash
cp .env.example .env.local
```

```bash
npm run dev
```

Abra http://localhost:5173, crie uma conta e siga o onboarding.

### Testes

```bash
npm run db:test
```

Sobe um Postgres 16 descartável, aplica as migrations e executa **240+ verificações** de isolamento entre empresas, RLS, disponibilidade, capacidade, bloqueios, duplicidade, histórico, notificações além do módulo de restaurante (alocação, uniões, ambiente, remarcação, lista de espera) do módulo de profissionais e da camada comercial (planos, limites, assinaturas, painel Innovai, suporte) e da inteligência (relatórios, recomendações, automações, ferramentas da IA), e três **corridas de 15 requisições simultâneas** — pelo último lugar, pela única mesa de 6 e pelo único profissional que faz um serviço (exatamente 1 vence em cada). A mesma suíte (`supabase/tests/rls_and_booking.test.sql`) também roda direto no banco do Supabase:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -f supabase/tests/rls_and_booking.test.sql -f supabase/tests/restaurant.test.sql -f supabase/tests/staff.test.sql -f supabase/tests/saas.test.sql -f supabase/tests/intelligence.test.sql
```

Teste ponta a ponta no navegador (requer Playwright instalado, app e Supabase rodando):

```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<anon-key> node e2e/smoke.mjs
```

```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<anon-key> node e2e/restaurant.mjs
```

```bash
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<anon-key> node e2e/barbershop.mjs
```

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node e2e/saas.mjs
```

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node e2e/intelligence.mjs
```

`smoke.mjs` cobre: cadastro → onboarding → reserva pública no celular → bloqueio de reserva duplicada → consulta por código + telefone → painel (lista, detalhe, histórico, CRM) → reserva manual → salvar horários → upload de logo → cancelamento online → notificação ao proprietário. `restaurant.mjs` cobre: ambientes → mesas → arrastar layout → união de mesas → ativar alocação por mesa → reserva pública escolhendo a Varanda → mesa V1 atribuída → mapa mostrando “chegada aguardada” → cliente sem reserva ocupando mesa → liberar mesa → lista de espera pública → aviso pelo painel. `barbershop.mjs` cobre: serviços → profissionais (horário próprio, serviços) → ativar agenda por profissional → cliente escolhe o Rafa → "qualquer profissional" no mesmo horário vai para o Léo → horário some quando todos estão ocupados → agenda em colunas → folga remove o profissional do dia → agendamento manual com serviço e profissional → métricas. `saas.mjs` cobre: operador Innovai → cria empresa no plano Starter com convite → cliente se cadastra e cai direto no painel → modos avançados bloqueados pelo plano → pedido de upgrade vira chamado → Innovai responde e muda para Pro → cliente vê a resposta e as funcionalidades liberadas. `intelligence.mjs` cobre: histórico de 30 dias → recomendações no dashboard → relatório avançado → assistente bloqueado fora do Business e, liberado, informando com clareza que não está configurado → automação de reconquista com prévia do público → job diário enfileira a mensagem.

---

## Deploy em produção

1. Crie um projeto no Supabase e aplique as migrations:
   ```bash
   npx supabase link --project-ref <ref>
   ```
   ```bash
   npx supabase db push
   ```
2. **Auth → URL Configuration:** defina `Site URL` com o domínio do app e adicione `https://SEU-DOMINIO/onboarding` e `https://SEU-DOMINIO/nova-senha` em Redirect URLs. Configure um SMTP próprio em Auth → SMTP (o SMTP padrão do Supabase tem limite baixo de envios).
3. Faça o deploy do frontend (Vercel, Netlify, Cloudflare Pages…) com as variáveis `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` e `VITE_PUBLIC_BASE_URL` (ex.: `https://innovaireserve.com`). Configure *SPA fallback* (todas as rotas → `index.html`); na Vercel isso já está em `vercel.json`.
4. Para tornar alguém **administrador Innovai** (acesso ao `/admin`), rode no SQL Editor:
   ```sql
   insert into public.platform_admins (user_id) select id from auth.users where email = 'voce@innovai.com';
   ```

---

## O que depende de configuração externa

Nada abaixo é simulado. Sem configuração, as mensagens ficam visíveis na tela **Notificações → Mensagens a clientes** com o status **“Requer configuração”**.

| Integração | Situação | O que configurar |
| --- | --- | --- |
| E-mail transacional (confirmação, lembrete, cancelamento) | Código pronto em `supabase/functions/notification-dispatcher` | Conta [Resend](https://resend.com) com domínio verificado. Secrets `RESEND_API_KEY` e `EMAIL_FROM` |
| WhatsApp automático | Código pronto (Cloud API da Meta) | Número no WhatsApp Business Platform, `WHATSAPP_TOKEN` e `WHATSAPP_PHONE_NUMBER_ID`, e **templates aprovados** na Meta com os nomes: `reservation_received`, `reservation_confirmed`, `reservation_cancelled`, `reservation_rescheduled`, `reminder`, `review_request`, `waitlist_available` (1 parâmetro de corpo). Sem isso, o botão “Avisar” da lista de espera abre o WhatsApp com a mensagem pronta |
| Agendamento do despachante | — | Extensões `pg_cron` e `pg_net` ativas + o job abaixo |
| Push notifications | Planejado | PWA + Web Push (VAPID) |
| Cobrança recorrente | Webhook pronto em `supabase/functions/billing-webhook` (Stripe) | Conta Stripe, preços com `metadata.plan_code`, assinaturas com `metadata.tenant_id`, secrets `STRIPE_SECRET_KEY` e `STRIPE_WEBHOOK_SECRET` (passo a passo no topo do arquivo). Asaas/Pagar.me exigem um webhook equivalente |
| Ciclo de vida das assinaturas | Função `refresh_subscription_states()` pronta | Agendar diariamente com `pg_cron` (abaixo) |
| Assistente de IA | Edge Function `supabase/functions/ai-assistant` pronta (Claude via SDK oficial) | Chave da API Anthropic: `supabase secrets set ANTHROPIC_API_KEY=...` e `supabase functions deploy ai-assistant`. Disponível para estabelecimentos com a funcionalidade `ai_insights` (plano Business ou exceção definida pela Innovai). Sem a chave, o painel informa "Assistente não configurado" |
| Automações (reconquista, aniversário) | Função `run_automations()` pronta | Agendar diariamente com `pg_cron` (abaixo); usam os mesmos canais de envio (WhatsApp/e-mail) e só alcançam clientes com consentimento |
| Rate limiting na borda | Recomendado | Cloudflare/WAF na frente das RPCs públicas (o banco já limita reservas ativas por telefone) |

Deploy do despachante:

```bash
npx supabase functions deploy notification-dispatcher --no-verify-jwt
```

```bash
npx supabase secrets set DISPATCH_SECRET=<gere-um-segredo> RESEND_API_KEY=... EMAIL_FROM="Reservas <reservas@seudominio.com>"
```

Agendamento a cada minuto (SQL Editor):

```sql
select cron.schedule('innovai-dispatch', '* * * * *', $$
  select net.http_post(
    url := 'https://<ref>.functions.supabase.co/notification-dispatcher',
    headers := jsonb_build_object('x-dispatch-secret', '<mesmo DISPATCH_SECRET>')
  )
$$);
```

Falhas são reprocessadas com *backoff* exponencial (até 5 tentativas).

Ciclo de vida das assinaturas (teste vencido → pendente; pendente há mais de 7 dias → suspenso), diariamente:

```sql
select cron.schedule('innovai-subscriptions', '17 6 * * *', $$ select public.refresh_subscription_states() $$);
```

Automações de relacionamento, diariamente pela manhã (horário UTC), e o endereço público usado nos links das mensagens:

```sql
select cron.schedule('innovai-automations', '43 12 * * *', $$ select public.run_automations() $$);
update public.platform_settings set public_base_url = 'https://SEU-DOMINIO';
```

---

## Estrutura

```
supabase/
  migrations/      01 schema · 02 segurança (RLS) · 03 motor de reservas · 04 API (RPCs)
                   05 SaaS comercial · 06 fila de notificações · 07 realtime/storage · 08 privilégios
                   09 inteligência (relatórios, recomendações, automações, ferramentas da IA)
  functions/       notification-dispatcher, billing-webhook, ai-assistant (Edge Functions)
  tests/           suítes SQL (MVP, restaurante, profissionais, SaaS, inteligência) + concorrência + runner local
src/
  api/             acesso a dados (Supabase + React Query), um arquivo por domínio
  components/      UI (design system), layout (AppShell), reservas (form/detalhe)
  hooks/           auth, tenant atual, realtime
  lib/             datas/fuso, constantes, erros, utilitários
  pages/           app (painel), public (página de reservas e consulta), auth, onboarding
e2e/smoke.mjs      teste ponta a ponta
docs/ARCHITECTURE.md  arquitetura, regras de negócio, segurança e roadmap
```

Veja **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** para as decisões técnicas, as regras de negócio e o plano das próximas fases.
