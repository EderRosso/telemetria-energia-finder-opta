# Site de Telemetria — login verificado, administrador e cliente

```
ESP32 / OPTA ──MQTT──► servidor Node.js ──► SQLite (dados/telemetria.db)
                                  └──► site: login (senha + 2FA)
                                       ├─ Administrador: tarifa, clientes, medidores, faturamento, usuários
                                       └─ Cliente: consumo e valor do mês, histórico, potência ao vivo
```

---

## 1. Instalar e rodar

Precisa do **Node.js 20 ou mais novo** (https://nodejs.org).

```bash
cd dashboard_web
npm install
copy .env.exemplo .env      # Windows   (Linux/Mac: cp .env.exemplo .env)
npm start
```

Abra **http://localhost:3000**.

Na primeira execução o terminal mostra o **administrador** e a **senha provisória**:

```
  PRIMEIRO ACESSO — administrador criado
  E-mail: admin@local
  Senha provisória: xxxxxxxxxxxxxx
```

> O `PREFIXO` do `.env` precisa ser **igual** ao `PREFIXO` do ESP32.

---

## 2. Como funciona o login verificado

| Etapa | O que acontece |
|---|---|
| 1. E-mail e senha | Senha guardada com **bcrypt** (nunca em texto). |
| 2. Troca da senha provisória | Só no 1º acesso. Mínimo de 10 caracteres, com letras e números. |
| 3. Cadastro do 2FA | Só no 1º acesso: ler o **QR Code** no Google Authenticator ou Microsoft Authenticator. |
| 4. Código de 6 dígitos | Em **todo** login. Muda a cada 30 s e não pode ser reutilizado. |

**Proteções incluídas**

- **Bloqueio de conta:** 5 senhas erradas bloqueiam a conta por 15 minutos.
- **Limite por IP:** no máximo 20 tentativas por IP a cada 15 minutos.
- **Código errado:** 5 códigos errados encerram a tentativa de login.
- **Sessão no cookie:**
  - o cookie é `HttpOnly` + `SameSite=Strict`, então o JavaScript não lê e outro site não usa;
  - o token é trocado ao concluir o login;
  - o login expira em 12 h.
- **Contra CSRF:** toda alteração exige o cabeçalho `X-Requested-With`.
- **Segredo do 2FA:** fica **criptografado** no banco (AES-256-GCM). A chave fica em `dados/chave.secreta` ou em `CHAVE_SECRETA` no `.env`.
- **Cabeçalhos de segurança** (Helmet + CSP): a página só carrega scripts do próprio servidor.
- **Separação de dados:** o cliente só enxerga os medidores dele. O filtro é feito no servidor, inclusive no tempo real (WebSocket).
- **Registro de segurança** (aba *Segurança*): guarda logins, falhas, bloqueios, trocas de senha e mudanças de tarifa.

**Perdeu o celular do 2FA?**
- **Usuário comum:** o admin clica em **Resetar 2FA** na aba *Usuários*.
- **O próprio admin:** use os comandos de emergência abaixo, no terminal do servidor.

```bash
npm run admin -- resetar-2fa admin@local
npm run admin -- redefinir-senha admin@local
npm run admin -- desbloquear email@cliente.com
npm run admin -- listar
```

---

## 3. Uso no dia a dia (administrador)

1. **Tarifas:** cadastre o valor do kWh e a data de início. Para reajustar, cadastre **uma nova vigência**. Os dias anteriores continuam com o valor antigo.
2. **Clientes:** cadastre quem paga a conta.
3. **Medidores:** cada medidor aparece **sozinho** quando envia a primeira leitura. Dê um nome e vincule a um cliente.
4. **Usuários:** crie o acesso do cliente. Aparece uma **senha provisória**, que você repassa a ele.
5. **Faturamento:** escolha o mês e baixe a planilha (CSV, abre no Excel).

**Como o valor é calculado**

- **Consumo** = diferença do **contador de energia do medidor** (registrador 2752). O contador nunca zera, então a conta continua certa mesmo se a internet cair.
- **Valor** = consumo de **cada dia** × tarifa vigente **naquele dia**.
- **Contador que diminui** (troca de medidor): esse trecho não é cobrado e aparece um **alerta** para conferir.

---

## 4. Testar sem a placa

```bash
npm run historico                          # cria 3 clientes, 3 medidores e 90 dias de leituras (SÓ TESTE)
npm run simular -- --medidores 3           # envia leituras ao vivo (IDs 33, 34, 35)
npm test                                   # testes automáticos (2FA e cálculo de consumo)
```

O `npm run historico` mostra os e-mails e as senhas provisórias dos clientes de teste.
Para começar do zero, apague a pasta `dados/`.

---

## 5. Antes de colocar no ar (produção)

- [ ] **Broker MQTT próprio** com usuário, senha e TLS, configurado em `MQTT_URL`, `MQTT_USUARIO` e `MQTT_SENHA`. O broker público é só para teste: qualquer pessoa que souber o prefixo lê ou injeta dados.
- [ ] **Site em HTTPS** (por exemplo, Cloudflare Tunnel ou Nginx com Let's Encrypt). Depois coloque `COOKIE_SEGURO=true` e `TRUST_PROXY=true`.
- [ ] **Backup** da pasta `dados/` (banco + `chave.secreta`).
- [ ] **Não compartilhe** os arquivos `.env` e `segredos.h`.

---

## 6. Estrutura

```
dashboard_web/
├── server.js            # inicia tudo
├── src/
│   ├── config.js        # lê o .env
│   ├── db.js            # tabelas do SQLite
│   ├── seguranca.js     # 2FA (TOTP), criptografia, tokens
│   ├── auth.js          # login em etapas, sessões, bloqueios
│   ├── telemetria.js    # recebe o MQTT e grava as leituras
│   ├── tempoReal.js     # WebSocket autenticado
│   ├── consumo.js       # cálculo de kWh e R$
│   └── rotas.js         # API do admin e do cliente
├── public/              # páginas: login, admin, cliente
├── scripts/             # simular, gerar histórico, comandos de admin
└── test/                # testes automáticos
```
