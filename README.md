# Chatbot comercial WhatsApp + PIX (Asaas)

Node.js 20 · Express · WhatsApp Cloud API (Meta) · Asaas (PIX) · PostgreSQL · Prisma · Vitest · Docker.

Fluxo: cliente conversa → monta pedido → endereço + CPF → resumo → pedido com id único e valor calculado no servidor → cobrança PIX no Asaas → copia-e-cola/QR no WhatsApp → webhook do Asaas → **consulta do estado real da cobrança** → pedido pago → resumo ao responsável (via outbox) + aviso ao cliente.

> ⚠️ **Status de verificação**: os 42 testes automatizados (mocks) passam. A camada Prisma/PostgreSQL, as chamadas reais à Meta/Asaas e o Docker **não foram executados** no ambiente onde o código foi gerado (sem acesso a binários do Prisma, Docker ou credenciais). Rode a seção "Primeira execução" e o teste em sandbox antes de produção. Endpoints/campos do Asaas e da Meta foram escritos a partir do conhecimento do autor — **confira com a documentação oficial vigente** (links no fim).

## Estrutura
```
src/server.js · app.js · container.js
src/config/       env.js (Zod) · catalog.js (CATÁLOGO) · logger.js · db.js
src/routes/       index.js (health, ready, webhooks)
src/controllers/  whatsappController.js · asaasController.js
src/services/     conversationService (máquina de estados) · orderService · paymentService
                  whatsappClient · asaasClient · outboxWorker · messages
src/repositories/ prismaStore.js (produção) · memoryStore.js (testes)
src/middlewares/  verifyMetaSignature · errorHandler · rateLimit
src/validators/   whatsapp.js · asaas.js      src/utils/  cpf, money, mutex, security...
prisma/schema.prisma · prisma/migrations/    tests/    Dockerfile · docker-compose.yml
```

## Comandos
```bash
npm install                       # dependências
cp .env.example .env              # e preencha (veja abaixo)
docker compose up -d db           # só o PostgreSQL
npx prisma generate
npm run migrate:deploy            # aplica as migrations
npm run dev                       # app em http://localhost:3000
npm test                          # testes (não precisam de banco/credenciais)
docker compose up -d --build      # app + banco em containers (roda migrate deploy ao subir)
docker compose logs -f app        # logs
docker compose down               # encerra (-v apaga o banco)
```
Saúde: `GET /health` (processo) e `GET /ready` (503 se o banco cair).

### Expor webhooks em desenvolvimento
Use um túnel HTTPS, por exemplo `cloudflared tunnel --url http://localhost:3000` ou `ngrok http 3000`. A URL pública gerada (ex.: `https://xxxx.trycloudflare.com`) é a base:
- Meta: `<URL>/webhooks/whatsapp`
- Asaas: `<URL>/webhooks/asaas`

## Trocar o catálogo
Edite `src/config/catalog.js` (`id`, `name`, `priceCents` em **centavos**). É validado ao iniciar. Os dados atuais são só exemplo. `createStaticCatalogProvider` pode ser substituído por um provedor que leia do banco (`getCatalog()` assíncrono) sem alterar o bot — útil para um painel administrativo futuro.

## Configuração do Asaas
1. Crie conta em asaas.com (e a conta Sandbox para testes). 2. Gere a **chave de API** → `ASAAS_API_KEY` e defina `ASAAS_ENV` (`sandbox`/`production`). 3. Cadastre uma **chave PIX** na conta (necessária para cobranças PIX). 4. Em Integrações → Webhooks, crie um webhook apontando para `<URL>/webhooks/asaas`, com **token de autenticação** = valor de `ASAAS_WEBHOOK_TOKEN` (o Asaas o envia no header `asaas-access-token`), eventos de cobrança (recebida/confirmada/vencida). 5. Teste no sandbox simulando o pagamento da cobrança.

O sistema **nunca** confia no corpo do webhook: ao receber o evento, consulta `GET /payments/{id}` e confere id, `externalReference` (= id do pedido), valor e status antes de marcar como pago.

## Configuração da Meta (WhatsApp Cloud API)
1. developers.facebook.com → criar app tipo **Business** → adicionar produto **WhatsApp**. 2. Em *Configurações do app → Básico* copie o **App Secret** → `WHATSAPP_APP_SECRET`. 3. Em WhatsApp → API Setup: anote o **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`. 4. Crie um **usuário do sistema** no Business Manager, atribua o app/ativo WhatsApp e gere um **token permanente** (permissões `whatsapp_business_messaging` e `whatsapp_business_management`) → `WHATSAPP_ACCESS_TOKEN`. 5. Em WhatsApp → Configuration → Webhook: URL `<URL>/webhooks/whatsapp`, Verify token = `WHATSAPP_VERIFY_TOKEN`, e assine o campo **messages**. 6. Verifique o negócio e cadastre o número comercial (abaixo). 7. Para o aviso ao responsável fora da janela de 24h, crie e aprove um **template** de utilidade com corpo `Novo pedido pago: {{1}}` e informe `OWNER_NOTIFY_TEMPLATE`.

**Janela de 24h**: mensagens livres só são aceitas até 24h após a última mensagem do destinatário. O cliente está dentro da janela durante o pedido. O **responsável normalmente não está** → use o template (`OWNER_NOTIFY_TEMPLATE`), ou peça que ele envie uma mensagem ao bot periodicamente. Sem template e fora da janela, o envio falha de forma permanente (status `FAILED` no outbox + log).

**Número já usado no WhatsApp Business (app)**: um número só pode estar ativo na Cloud API *ou* no app, exceto se o recurso de **coexistência** estiver disponível para sua conta/país/versão do app. Verifique: (a) no WhatsApp Manager, ao adicionar o número, veja se a opção de conectar mantendo o app é oferecida; (b) a documentação atual da Meta sobre "coexistence"/Embedded Signup e seus requisitos. Não presuma que a migração é automática: sem coexistência, registrar o número na API o desconecta do app (e o histórico não migra). Considere um número novo para o bot.

## Segurança implementada
Assinatura HMAC (`X-Hub-Signature-256`) sobre o corpo bruto · token do webhook Asaas em tempo constante · Zod em env/payloads/catálogo · helmet · rate limit · logs pino com redação de segredos e telefone mascarado · erros centralizados · deduplicação de mensagens da Meta · eventos do Asaas idempotentes · transições de status com `UPDATE ... WHERE status='AWAITING_PAYMENT'` em transação · CPF usado só para criar a cobrança (removido do estado da conversa depois) · nenhum segredo no repositório.

## Garantias e limitações
- **Entrega exatamente uma vez não é possível**: a API do WhatsApp não tem chave de idempotência. O outbox garante *pelo menos uma vez*; se o processo cair após a Meta aceitar e antes de gravar `SENT` (ou houver timeout com envio já feito), a mensagem pode ser reenviada. É raro e o risco é uma mensagem duplicada, nunca perdida.
- A serialização por telefone (`KeyedMutex`) é por processo: com várias instâncias, use advisory locks do Postgres ou uma instância só. Dedup/transições de pedido já são seguras no banco.
- Pedidos com PIX não pago não expiram sozinhos se o webhook de vencimento falhar; o cliente pode usar `status`. Considere um job periódico de reconciliação.
- `InboundMessage` cresce sem limite: agende limpeza de registros antigos (> 30 dias).
- O Asaas exige CPF/CNPJ do pagador na criação do cliente (por isso o bot pede o CPF); confirme as regras vigentes da sua conta.
- A conversa é por texto (menu numerado); não usa botões/listas interativas.
- LGPD: telefone, endereço e nome ficam no banco; defina retenção e base legal, e informe o cliente. Garanta consentimento/opt-in conforme as políticas da Meta.

## Checklist de produção
- [ ] `ASAAS_ENV=production` + chave de produção + webhook de produção cadastrado
- [ ] Token permanente da Meta, App Secret, número verificado, webhook assinado em `messages`
- [ ] Template do responsável aprovado e `OWNER_NOTIFY_TEMPLATE` preenchido
- [ ] Catálogo real em `src/config/catalog.js`
- [ ] Segredos fortes (`ASAAS_WEBHOOK_TOKEN`, `WHATSAPP_VERIFY_TOKEN`), `.env` fora do git
- [ ] HTTPS com domínio fixo (sem túnel), `TRUST_PROXY` correto
- [ ] Senha do Postgres forte, backup automático, porta do banco não exposta
- [ ] Testar fluxo ponta a ponta no sandbox e 1 pagamento real de valor baixo
- [ ] Monitorar logs e linhas `Outbox` com `status='FAILED'`, e alertas `OWNER_ALERT`
- [ ] Política de retenção/limpeza de dados e aviso de privacidade

## Documentação oficial
Meta: developers.facebook.com/docs/whatsapp/cloud-api · Asaas: docs.asaas.com
