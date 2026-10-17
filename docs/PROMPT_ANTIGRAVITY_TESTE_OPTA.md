# PROMPT — Teste integrado: OPTA 8A.04-8310 + Finder 7M.38 + Site v2

> Cole este prompt inteiro no agente do Antigravity, com a pasta **ProjetoSimples** (versão 2.1) aberta.
> Trabalhe em **fases**. Antes de cada fase, apresente o plano. Depois de cada fase, mostre a evidência do critério de aceite e **espere minha confirmação** antes de seguir.
> Tudo em **português do Brasil**: respostas, comentários de código e documentação.

---

## 1. Contexto

Estou montando um sistema de telemetria e cobrança de energia elétrica:

```
Finder 7M.38 ──RS-485 (Modbus RTU)──► OPTA 8A.04-8310 ──Ethernet / MQTT──► Broker ──► Servidor Node.js (dashboard_web) ──► Site (admin e cliente)
```

O que **já existe** na pasta e **já foi testado**:

| Pasta | O que é | Situação |
|---|---|---|
| `dashboard_web/` | Servidor Node.js + SQLite + site com login verificado (senha + 2FA), painel do admin e painel do cliente | Testado com simulador (`npm test` passa) |
| `esp32_medidor_7m38_wifi/` | ESP32 que **simula** o medidor e envia MQTT (gateway `esp32sim`) | Funcionando |
| `opta_telemetria_7m38/` | **Programa definitivo do OPTA** — lê o 7M.38 por Modbus RTU e publica MQTT pela Ethernet | **NOVO — ainda não compilado nem testado** |
| `broker_mosquitto/` | Configuração de um broker próprio com usuário, senha e ACL | Novo |

O objetivo deste prompt é **compilar e testar o programa do OPTA com o hardware real** e validar o sistema de ponta a ponta.

### Hardware na bancada

- **OPTA Plus 8A.04-8310:**
  - porta Ethernet (RJ45) e RS-485;
  - **não tem Wi-Fi**;
  - alimentação de 12–24 V DC.
- **Medidor Finder 7M.38 com Modbus:**
  - ID **33**;
  - **19200 bps, 8N2**;
  - mapa de registradores na seção 3.
- **Rede:** cabo de rede ligando o OPTA ao roteador, e um PC na mesma rede.
- **Cabos e acessórios:** cabo USB-C (programação do OPTA) e cabo par trançado para o RS-485.

---

## 2. Regras de ouro (não negociáveis)

1. **O contrato MQTT não muda.** Tópicos e JSON são os da seção 4, os mesmos do ESP32. O servidor e o site **não devem ser alterados** para "acomodar" o OPTA.
2. **Não invente registradores.** Use só os da seção 3. Esses registradores foram conferidos com o manual e com os exemplos oficiais da Finder (github.com/Engenharia-Finder: `OPTA-PROG-MODBUS7M-PROGFINDER` e `OPTA-PROG-MODBUS7M-PROGARDUINO`).
3. **Mudanças no programa do OPTA:**
   - só o necessário para compilar e funcionar;
   - mostre o *diff* de cada mudança e explique o motivo;
   - **não reescreva** o programa do zero.
4. **O programa nunca pode travar esperando a rede.** Sem internet, o OPTA continua lendo os medidores.
5. **Nenhuma senha no código.**
   - Senhas ficam em `segredos.h` (OPTA e ESP32) e `.env` (servidor), todos no `.gitignore`.
   - **Não mostre** o conteúdo desses arquivos nas respostas.
6. **Não altere a lógica de cobrança** (`dashboard_web/src/consumo.js`). Se achar um problema, descreva e pergunte antes.
7. **Um gateway por nome:**
   - OPTA = `opta01`;
   - ESP32 simulador = `esp32sim`.

   Nunca rode os dois com o mesmo `GATEWAY_ID`, porque os contadores de energia se misturam.

---

## 3. Mapa de registradores do 7M.38

Todos os registradores:
- usam a **função 04** (input registers);
- trazem o valor em **float32 IEEE-754**, ocupando 2 registradores;
- vêm com a **palavra mais significativa primeiro**.

| Grandeza | Registrador | Hex | Unidade | Chave no JSON |
|---|---|---|---|---|
| Potência ativa total | 2490 | 0x09BA | W | `potencia_w` |
| Frequência | 2498 | 0x09C2 | Hz | `frequencia_hz` |
| Tensão U1 | 2500 | 0x09C4 | V | `tensao_v` |
| Corrente I1 | 2516 | 0x09D4 | A | `corrente_a` |
| Fator de potência PF1 | 2554 | 0x09FA | — | `fp` |
| **Contador de energia n1** | **2752** | **0x0AC0** | **Wh** | `energia_kwh` (÷ 1000) |

O **contador de energia (2752) é a base da cobrança**. Ele nunca diminui e deve bater com o display do medidor.

---

## 4. Contrato MQTT (o mesmo do ESP32 — não alterar)

| Tópico | Conteúdo | QoS / Retain |
|---|---|---|
| `{PREFIXO}/telemetria/opta01/medidor/{slave_id}` | JSON da leitura | 0 / não |
| `{PREFIXO}/telemetria/opta01/status` | `online` / `offline` (`offline` vem pelo LWT) | 1 / **sim** |

```json
{"ts":"2026-10-17T18:30:05Z","slave_id":33,"modelo":"FINDER_7M38","ok":true,
 "valores":{"tensao_v":127.32,"corrente_a":4.639,"potencia_w":544.7,"fp":0.955,
            "frequencia_hz":60.02,"energia_kwh":1500.001},"erros":[]}
```

- Se o medidor não responder: `"ok":false,"valores":{},"erros":["timeout"]`.
- Se o relógio ainda não foi acertado pelo NTP: `"ts":null`. O servidor usa a hora dele nesse caso.

---

## 5. Fases

### Fase 0 — Revisão e ambiente

1. Leia e me resuma em até 15 linhas:
   - `opta_telemetria_7m38/opta_telemetria_7m38.ino`;
   - `dashboard_web/src/telemetria.js`, para confirmar que o JSON do OPTA é aceito.
2. Instale e confirme as versões:
   - `arduino-cli`, com o pacote de placas **`arduino:mbed_opta`**;
   - as bibliotecas **ArduinoModbus**, **ArduinoRS485** e **PubSubClient** (Nick O'Leary).
3. Crie `opta_telemetria_7m38/segredos.h` a partir do `segredos.exemplo.h`. Por enquanto, usuário e senha ficam vazios, para o broker público.

**Aceite:**
- `arduino-cli core list` mostra `arduino:mbed_opta`;
- as 3 bibliotecas aparecem em `arduino-cli lib list`.

### Fase 1 — Compilar o programa do OPTA

```bash
arduino-cli compile --fqbn arduino:mbed_opta:opta opta_telemetria_7m38
```

O programa foi escrito com base nos fontes do core, mas **ainda não foi compilado**. Se der erro, confira especialmente:

- `Ethernet.begin(nullptr, 15000, 4000)` (DHCP com tempo limite), `Ethernet.linkStatus()` e o enum `LinkOFF`;
- `clienteRede.setSocketTimeout(5000)` (EthernetClient do core mbed);
- `mbed::Watchdog::get_instance().start(30000)` / `.kick()`. Se não compilar, deixe `USAR_WATCHDOG 0` e me avise;
- `udpNtp.beginPacket("pool.ntp.org", 123)` (UDP com nome de servidor). Se não aceitar o nome, resolva o IP por DNS antes;
- `String(float, casas)` para montar o JSON (não use `printf` com `%f`).

**Aceite:**
- compila **sem erros**, com tamanho do binário e uso de RAM informados;
- cada alteração foi mostrada em *diff*, com o motivo.

### Fase 2 — Bancada Modbus (OPTA ↔ 7M.38)

1. **Ligações** (com tudo desligado):
   - RS-485: terminal **A** do OPTA no **A** do 7M.38, e **B** no **B**. Use par trançado.
   - Ponha um resistor de **120 Ω** entre A e B nas duas pontas, se o cabo for longo. Em bancada curta, costuma funcionar sem.
   - Alimente o OPTA com 12–24 V DC.
2. **No display do 7M.38**, confira:
   - endereço **33**;
   - **19200** bps;
   - paridade/stop **8N2**.
3. **Grave** o OPTA:
   ```bash
   arduino-cli upload -p <porta> --fqbn arduino:mbed_opta:opta opta_telemetria_7m38
   ```
   e abra o monitor:
   ```bash
   arduino-cli monitor -p <porta> -c baudrate=115200
   ```
4. Com uma **carga conhecida** ligada (lâmpada, aquecedor ou ferro), compare o Monitor Serial com o display do medidor.

**Aceite (registre os valores numa tabela):**

| Teste | Esperado |
|---|---|
| Tensão, corrente, potência e frequência | Iguais ao display (diferença ≤ 1%) |
| `energia_kwh` | Igual ao contador do display (kWh) |
| LED D2 | Aceso com o medidor respondendo |
| Desconectar o fio A ou B | Log `[MODBUS] ID 33 sem resposta`, JSON com `"ok":false`, LED D2 apaga, **o OPTA não trava** |
| Reconectar o fio | Leituras voltam sozinhas, sem reiniciar |

**Se o medidor não responder**, verifique nesta ordem:
- A e B invertidos;
- ID, baud ou paridade diferentes no medidor;
- falta de GND comum;
- terminação ausente.

### Fase 3 — MQTT pelo broker público (teste rápido)

1. No `.ino`, use um `PREFIXO` **único** (ex.: `eder_telemetria_<4 dígitos>`). Mantenha `MQTT_HOST = "broker.hivemq.com"` e porta 1883. Grave de novo.
2. No PC, escute o broker:
   - `python receptor_pc/receptor_mqtt.py --prefixo <PREFIXO>`, ou
   - `mosquitto_sub -h broker.hivemq.com -t "<PREFIXO>/telemetria/#" -v`.

**Aceite:**

| Teste | Esperado |
|---|---|
| Inicialização | Monitor mostra o IP (DHCP), `[NTP] Relógio acertado`, `[MQTT] Conectado`; LEDs D0 e D1 acesos |
| Leituras | 1 JSON a cada 5 s, no formato da seção 4, com `ts` preenchido |
| Status | Mensagem retida `online` em `.../opta01/status` |
| **Tirar o cabo de rede** | Em até ~25 s aparece `offline` (LWT). O Monitor continua lendo o medidor (`[FALHA]` na publicação). **Nada trava.** |
| Recolocar o cabo | Reconecta sozinho, volta `online`, sem reiniciar |
| Reiniciar a energia do OPTA | Volta a publicar sozinho em menos de 1 min |

### Fase 4 — Site v2 com o OPTA real

1. Prepare o servidor:
   ```bash
   cd dashboard_web
   npm install
   copy .env.exemplo .env
   ```
   No `.env`, coloque o mesmo `PREFIXO` do OPTA.
2. Comece com **banco limpo**: apague a pasta `dashboard_web/dados/` se existir.
   **Não rode** `npm run historico` neste banco. Ele cria dados falsos para o medidor `opta01/33` e o contador real ficaria "andando para trás".
3. Inicie com `npm start`, entre como admin, troque a senha provisória e cadastre o 2FA.
4. No site:
   - o medidor **`opta01 / ID 33`** deve aparecer sozinho;
   - dê um nome a ele;
   - crie um cliente de teste e vincule o medidor;
   - cadastre uma tarifa (ex.: R$ 0,95/kWh a partir de hoje);
   - crie o usuário desse cliente.
5. Entre como o cliente (em outra janela anônima) e faça o primeiro acesso, com troca de senha e 2FA.

**Aceite:**

| Teste | Esperado |
|---|---|
| Medidor novo | Aparece sozinho como "Sem cliente" |
| Tempo real (admin e cliente) | Potência na tela igual ao display (atualiza a cada ~5 s) |
| **Consumo após ≥ 1 h com carga** | "kWh no mês" do site = contador do display agora − contador anotado no início (diferença ≤ 0,01 kWh) |
| Valor | R$ = kWh × tarifa |
| Isolamento | O cliente vê **só** o próprio medidor |
| Cabo de rede fora por 10 min | O consumo desse período **não se perde**: ao voltar, o kWh do site alcança o display |

### Fase 5 — Broker próprio com usuário e senha (Mosquitto)

Siga `broker_mosquitto/LEIA-ME.md`:

1. Instale o Mosquitto no PC.
2. Crie os usuários `opta01` e `servidor` e use o arquivo `acl`, ajustando o prefixo dentro dele.
3. No OPTA: `MQTT_HOST` = IP do PC, e `segredos.h` com usuário e senha do `opta01`.
4. No `.env` do servidor:
   - `MQTT_URL=mqtt://localhost:1883`;
   - `MQTT_USUARIO=servidor`;
   - `MQTT_SENHA=...`.

**Aceite:**
- tudo volta a funcionar como na Fase 4;
- **conexão sem senha é recusada** (`mosquitto_sub` sem usuário dá "not authorized");
- o usuário `opta01` **não consegue** publicar em `.../telemetria/outro_gateway/...` (ACL).

### Fase 6 — Teste de 24 horas

Deixe tudo ligado por 24 h, com carga variando.

**Aceite:**
- nenhum reinício inesperado do OPTA (veja o log; se o watchdog atuou, anote);
- consumo de 24 h no site = diferença do display (≤ 0,01 kWh);
- nenhum alerta de "contador diminuiu" no Faturamento;
- a aba **Segurança** do site mostra os logins do teste.

### Fase 7 — Relatório

Crie `docs/RELATORIO_TESTES_OPTA.md` com:
- versões (arduino-cli, core, bibliotecas, Node);
- o que foi alterado no `.ino` e por quê;
- a tabela de cada fase com ✅ / ❌ e os valores medidos (site × display);
- problemas encontrados e pendências.

---

## 6. Tabela de diagnóstico

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `[MODBUS] ... sem resposta` sempre | A/B invertidos, ID/baud/paridade diferentes | Inverter A/B; conferir 33 / 19200 / 8N2 no medidor |
| Valores absurdos (ex.: 1e-38) | Ordem das palavras do float | Confirmar com o exemplo oficial da Finder (palavra alta primeiro). **Não mude** sem me avisar |
| `[REDE] Sem rede` | Cabo, porta do roteador, DHCP | Testar outro cabo/porta; usar `USAR_IP_FIXO 1` |
| `[MQTT] Falha, rc=-2` | Broker inacessível (porta 1883 bloqueada, IP errado) | Testar com `mosquitto_sub` no PC; liberar o firewall |
| `rc=4` ou `rc=5` | Usuário/senha errados ou sem permissão (ACL) | Conferir `segredos.h`, o `passwd` e o `acl` |
| Site não mostra o medidor | `PREFIXO` diferente entre OPTA e `.env` | Igualar e reiniciar o servidor |
| "Contador diminuiu" no site | Mesmo gateway/ID usado pelo ESP32 e pelo OPTA, ou dados de demonstração | Apagar `dados/` e garantir `esp32sim` × `opta01` |

---

## 7. Regras de trabalho

1. Planeje antes de cada fase e mostre evidências (logs, prints, tabelas) depois.
2. Nas fases com hardware, **me peça para fazer** as ligações e as leituras do display. Você não tem acesso físico.
3. Código simples e comentado, pensado para quem está aprendendo. O projeto também é material didático.
4. Se algo deste prompt estiver errado ou impossível, **diga e proponha** a alternativa. Não contorne em silêncio.
