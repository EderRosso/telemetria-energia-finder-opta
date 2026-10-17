# ⚡ Telemetria de Energia — Finder 7M.38 + OPTA + Dashboard Web (v2.1)

Sistema completo, profissional e seguro para medição, telemetria em tempo real e rateio/cobrança de energia elétrica industrial e comercial. Integra medidores **Finder 7M.38** via **Modbus RTU (RS-485)** com controladores **Arduino / Finder OPTA (Ethernet/MQTT)** e um **servidor web Node.js** com banco SQLite, login em duas etapas (2FA) e painéis dedicados para Administrador e Cliente.

---

## 📌 Sumário
- [1. Visão Geral e Arquitetura](#1-visão-geral-e-arquitetura)
- [2. Principais Funcionalidades](#2-principais-funcionalidades)
- [3. Estrutura do Repositório](#3-estrutura-do-repositório)
- [4. Mapa de Registradores do Finder 7M.38](#4-mapa-de-registradores-do-finder-7m38)
- [5. Contrato MQTT](#5-contrato-mqtt)
- [6. Como Instalar e Rodar](#6-como-instalar-e-rodar)
  - [Opção A: Testando o Dashboard Web com Simulador](#opção-a-testando-o-dashboard-web-com-simulador-sem-placas)
  - [Opção B: Transmissão com Simulador ESP32 (Wi-Fi)](#opção-b-transmissão-com-simulador-esp32-wi-fi)
  - [Opção C: Instalação Definitiva com Arduino OPTA (Ethernet/RS-485)](#opção-c-instalação-definitiva-com-arduino-opta-ethernetrs-485)
- [7. Regras de Cobrança e Tarifa](#7-regras-de-cobrança-e-tarifa)
- [8. Segurança e Boas Práticas](#8-segurança-e-boas-práticas)
- [9. Comandos de Emergência (CLI)](#9-comandos-de-emergência-cli)
- [10. Licença e Autoria](#10-licença-e-autoria)

---

## 1. Visão Geral e Arquitetura

O sistema atende a dois cenários:
1. **Produção / Instalação Física:** O medidor de energia Finder 7M.38 comunica-se via par trançado RS-485 com o PLC Finder OPTA Plus. O OPTA publica os dados via Ethernet (MQTT) para o servidor.
2. **Ambiente de Testes / Bancada:** Um microcontrolador ESP32 simula a memória Modbus e a dinâmica elétrica do Finder 7M.38, enviando via Wi-Fi o **mesmo contrato JSON** ao broker MQTT.

```
+───────────────────────────+
|     Finder 7M.38          |  (Medidor de Energia Trifásico/Monofásico)
+─────────────┬─────────────+
              │ RS-485 / Modbus RTU (19200 8N2, ID 33)
              ▼
+───────────────────────────+
|    OPTA Plus 8A.04-8310   |  (Gateway Industrial Ethernet)
+─────────────┬─────────────+
              │ Ethernet / MQTT (QoS 0-1, LWT)
              ▼
+───────────────────────────+
|        Broker MQTT        |  (HiveMQ Público para testes ou Mosquitto com TLS/ACL)
+─────────────┬─────────────+
              │ Internet / Intranet
              ▼
+───────────────────────────+
|     Servidor Node.js      |  (Express, SQLite WAL, WebSockets, TOTP RFC 6238)
+─────────────┬─────────────+
              │ HTTP / WebSockets (autenticado)
              ▼
    ┌───────────────────────────┬───────────────────────────┐
    │  Painel do Administrador  │     Área do Cliente       │
    │  - Tarifas com vigência   │  - Consumo do mês (kWh)   │
    │  - Cadastro de clientes   │  - Valor em R$ do período │
    │  - Vinculação de medidores│  - Comparativo mês anterior│
    │  - Faturamento e CSV      │  - Gráfico por dia        │
    │  - Medição ao vivo        │  - Potência ao vivo       │
    │  - Registro de segurança  │  - Histórico de 12 meses  │
    └───────────────────────────┴───────────────────────────┘
```

---

## 2. Principais Funcionalidades

### 🔐 Segurança de Nível Bancário
- **Login Verificado em 4 Etapas:** E-mail e senha (bcrypt custo 12), troca de senha provisória, ativação de 2FA com QR Code (Google/Microsoft Authenticator) e código de 6 dígitos.
- **Proteção contra Replay:** Códigos TOTP (RFC 6238) de 30 segundos não podem ser reutilizados dentro do mesmo passo de tempo.
- **Segredo do 2FA Criptografado:** Cifrado em repouso no banco com **AES-256-GCM**.
- **Defesa Contra Ataques:**
  - Bloqueio de conta por 15 minutos após 5 erros de senha.
  - Rate limiting por IP contra força bruta.
  - Bloqueio contra CSRF em todas as rotas POST/PUT/DELETE (`X-Requested-With: fetch`).
  - Proteção contra CSWSH (Cross-Site WebSocket Hijacking) validando `Origin` contra `Host`.
  - Cabeçalhos HTTP seguros com `Helmet` (CSP estrito sem CDNs ou scripts externos).
  - Cookies de sessão com flags `HttpOnly` e `SameSite=Strict`.

### ⚡ Telemetria e Faturamento Preciso
- **Cálculo Baseado no Contador do Medidor:** A cobrança calcula o delta do contador totalizador acumulado em Wh (registrador 2752), garantindo precisão mesmo com eventuais quedas de internet.
- **Acumulador ESP32 em precisão dupla (`double`):** Corrige a perda de fração de precisão observada em acumuladores `float32`.
- **Tarifas Históricas com Vigência:** Aplica o valor exato da tarifa correspondente ao dia local (fuso horário de Brasília `-180 min`).
- **Detecção de Troca/Reset de Medidor:** Alerta o administrador caso o contador apresente queda inesperada, sem cobrar valores negativos.
- **Exportação de Faturamento:** Relatórios mensais com exportação para planilha CSV (com proteção contra formula injection).

---

## 3. Estrutura do Repositório

```text
ProjetoSimples/
├── .gitignore                         # Protege segredos, .env, bancos locais e dependências
├── README.md                          # Documentação principal do repositório
├── PLANO_CONFIG_MQTT_ADMIN.md         # Especificação técnica: configuração MQTT via painel
├── broker_mosquitto/                  # Configurações do broker privado próprio
│   ├── mosquitto.conf                 # Configuração de porta, persistência e autenticação
│   ├── acl                            # Regras de controle de acesso por tópico e usuário
│   └── LEIA-ME.md                     # Guia de configuração do Mosquitto
├── esp32_medidor_7m38_wifi/           # Simulador completo no ESP32
│   ├── esp32_medidor_7m38_wifi.ino    # Código Arduino com tabela Modbus e MQTT
│   ├── segredos.exemplo.h             # Modelo versionado de credenciais
│   └── segredos.h                     # Dados de Wi-Fi e MQTT reais (ignorado pelo git)
├── opta_telemetria_7m38/              # Firmware definitivo para o Finder OPTA
│   ├── opta_telemetria_7m38.ino       # Modbus RTU mestre (RS-485) + Ethernet + MQTT
│   ├── segredos.exemplo.h             # Modelo versionado de credenciais do OPTA
│   └── segredos.h                     # Credenciais do broker de produção (ignorado pelo git)
└── dashboard_web/                     # Aplicação Web (Node.js + SQLite + Frontend)
    ├── package.json                   # Dependências e scripts npm
    ├── .env.exemplo                   # Modelo de variáveis de ambiente
    ├── server.js                      # Inicialização do servidor Express e WebSocket
    ├── src/                           # Código modular do backend
    │   ├── config.js                  # Carregamento e validação de configurações
    │   ├── db.js                      # Inicialização do SQLite (WAL) e tabelas
    │   ├── seguranca.js               # TOTP nativo, AES-256-GCM, tokens de sessão
    │   ├── auth.js                    # Middlewares de sessão, rotas de login e 2FA
    │   ├── telemetria.js              # Ingestão e validação MQTT
    │   ├── tempoReal.js               # Servidor WebSocket autenticado com filtros de perfil
    │   ├── consumo.js                 # Algoritmo de cálculo de kWh e faturamento
    │   └── rotas.js                   # Rotas de API do Administrador e do Cliente
    ├── public/                        # Interface Web responsiva (HTML/CSS/JS puro)
    │   ├── login.html                 # Telas de login, troca de senha e 2FA
    │   ├── admin.html                 # Painel de controle do Administrador
    │   ├── cliente.html               # Painel de autoatendimento do Cliente
    │   ├── css/app.css                # Estilização completa (tema escuro profissional)
    │   └── js/                        # Controladores de tela e conexões em tempo real
    ├── scripts/                       # Scripts auxiliares e ferramentas de teste
    │   ├── simular.js                 # Simulador MQTT de múltiplos medidores
    │   ├── gerar-historico.js         # Geração de 90 dias de leituras e clientes teste
    │   └── admin-cli.js               # Utilitário de linha de comando para emergências
    └── test/                          # Testes unitários automatizados (node:test)
        ├── seguranca.test.js          # Validação de vetores RFC 6238 e criptografia
        └── consumo.test.js            # Validação do cálculo de energia e tarifas
```

---

## 4. Mapa de Registradores do Finder 7M.38

Conforme manual do fabricante e implementações de referência da Engenharia Finder:
- **Função Modbus:** `04` (Input Registers)
- **Formato dos Dados:** `IEEE-754 Float32` em 2 registradores consecutivos de 16 bits
- **Ordem de Bytes:** Palavra Mais Significativa primeiro (**MSW / Big-Endian Word Order**)
- **Padrão de Fábrica RS-485:** ID Modbus `33`, `19200 bps`, `8N2`

| Grandeza Elétrica | Endereço Modbus | Registradores (16 bits) | Unidade | Chave no JSON |
|---|:---:|:---:|:---:|:---:|
| **Potência Ativa Total** | 2490 (0x09BA) | 2490 e 2491 | W | `potencia_w` (OPTA) |
| **Frequência** | 2498 (0x09C2) | 2498 e 2499 | Hz | `frequencia_hz` |
| **Tensão Fase 1 (U1)** | 2500 (0x09C4) | 2500 e 2501 | V | `tensao_v` |
| **Corrente Fase 1 (I1)** | 2516 (0x09D4) | 2516 e 2517 | A | `corrente_a` |
| **Potência Ativa Fase 1** | 2530 (0x09E2) | 2530 e 2531 | W | `potencia_w` (ESP32) |
| **Fator de Potência 1** | 2554 (0x09FA) | 2554 e 2555 | — | `fp` |
| **Contador de Energia n1** | **2752 (0x0AC0)** | 2752 e 2753 | **Wh** | `energia_kwh` (÷ 1000) |

---

## 5. Contrato MQTT

Tanto o **ESP32** (simulador) quanto o **Finder OPTA** (hardware real) utilizam estritamente o mesmo formato de tópicos e payloads:

### Tópicos
- **Status do Gateway (LWT):** `{PREFIXO}/telemetria/{GATEWAY_ID}/status` (QoS 1, Retido)
  - Mensagens: `online` ao conectar, `offline` em caso de queda (publicado pelo broker via LWT).
- **Leitura do Medidor:** `{PREFIXO}/telemetria/{GATEWAY_ID}/medidor/{SLAVE_ID}` (QoS 0 ou 1, Não retido)

> **Identificadores Padrão:**
> - Gateway OPTA Real: `opta01`
> - Gateway ESP32 Simulado: `esp32sim`
> - Medidor: `33`

### Formato do Payload JSON
```json
{
  "ts": "2026-10-17T18:30:05Z",
  "slave_id": 33,
  "modelo": "FINDER_7M38",
  "ok": true,
  "valores": {
    "tensao_v": 127.32,
    "corrente_a": 4.639,
    "potencia_w": 544.7,
    "fp": 0.955,
    "frequencia_hz": 60.02,
    "energia_kwh": 1500.001
  },
  "erros": []
}
```
*(Caso o equipamento não tenha relógio NTP sincronizado, `"ts"` é enviado como `null` e o servidor adota o horário de chegada).*

---

## 6. Como Instalar e Rodar

### Opção A: Testando o Dashboard Web com Simulador (Sem Placas)

1. **Requisitos:** Node.js 20+ instalado no computador.
2. Acesse a pasta do painel web e instale as dependências:
   ```bash
   cd dashboard_web
   npm install
   ```
3. Crie o arquivo `.env` (caso ainda não exista):
   ```bash
   copy .env.exemplo .env    # Windows
   cp .env.exemplo .env      # Linux / macOS
   ```
4. Gere uma base de demonstração (3 clientes, 3 medidores e 90 dias de histórico):
   ```bash
   npm run historico
   ```
5. Inicie o servidor:
   ```bash
   npm start
   ```
6. Em outro terminal, inicie o simulador de telemetria contínua via MQTT:
   ```bash
   npm run simular -- --medidores 3
   ```
7. Acesse no navegador: **[http://localhost:3000](http://localhost:3000)**.
   - No terminal do servidor aparecerá o e-mail (`admin@local`) e a senha provisória de primeiro acesso.

---

### Opção B: Transmissão com Simulador ESP32 (Wi-Fi)

1. Conecte o ESP32 ao computador via USB.
2. Abra a pasta `esp32_medidor_7m38_wifi/` na Arduino IDE.
3. Copie `segredos.exemplo.h` para `segredos.h` e informe seu SSID e senha de Wi-Fi (2.4 GHz).
4. Instale na Arduino IDE a biblioteca **PubSubClient**.
5. Selecione a placa **ESP32 Dev Module** e a porta serial correspondente.
6. Faça o upload do código e abra o Monitor Serial a `115200 bps`.
7. O ESP32 conectará à rede e começará a transmitir as grandezas a cada 5 segundos.

---

### Opção C: Instalação Definitiva com Arduino OPTA (Ethernet/RS-485)

1. Conecte o medidor Finder 7M.38 aos bornes RS-485 do OPTA:
   - Terminal A (+) do 7M.38 ➔ Terminal A (+) do OPTA
   - Terminal B (-) do 7M.38 ➔ Terminal B (-) do OPTA
   - COM (Blindagem) ➔ Terminal COM do OPTA
2. Conecte o cabo de rede Ethernet (RJ45) ao OPTA.
3. Abra `opta_telemetria_7m38/opta_telemetria_7m38.ino` na Arduino IDE.
4. Instale as bibliotecas necessárias:
   - `ArduinoModbus`
   - `ArduinoRS485`
   - `PubSubClient`
5. Configure `segredos.h` caso o broker MQTT exija usuário e senha.
6. No menu *Ferramentas*, selecione a placa **Opta** (sob *Arduino Mbed OS Opta Boards*) e envie o código.
7. O painel de LEDs do OPTA indicará o status:
   - **D0:** Cabo de rede conectado e IP atribuído.
   - **D1:** Conexão MQTT estabelecida.
   - **D2:** Resposta bem-sucedida do barramento Modbus.
   - **D3:** Pisca a cada publicação enviada.

---

## 7. Regras de Cobrança e Tarifa

1. **Base da Cobrança:** A apuração utiliza a **diferença do contador acumulado de energia** (`energia_kwh`, registrador 2752). Não é realizada integração por potência, eliminando desvios acumulados.
2. **Tarifação Diária:** O consumo de cada dia é multiplicado pela tarifa vigente **naquela data específica**. Reajustes tarifários entram em vigor a partir da data cadastrada pelo administrador sem afetar retroativamente o faturamento já consolidado.
3. **Fuso Horário:** Todo o agrupamento diário respeita o fuso horário configurado no servidor (`FUSO_MINUTOS = -180` para o Horário de Brasília).

---

## 8. Segurança e Boas Práticas

- **Credenciais Fora do Repositório:** Senhas e chaves privadas nunca são enviadas ao Git. Os arquivos sensíveis estão registrados no `.gitignore`:
  - `esp32_medidor_7m38_wifi/segredos.h`
  - `opta_telemetria_7m38/segredos.h`
  - `dashboard_web/.env`
  - `dashboard_web/dados/`
- **Ambiente de Produção:**
  - Utilize um broker MQTT privado com autenticação e TLS ativo (porta 8883) — veja instruções detalhadas em `broker_mosquitto/LEIA-ME.md`.
  - Coloque o servidor web sob HTTPS (via Nginx, Caddy ou Cloudflare Tunnel) e defina no `.env`:
    ```env
    COOKIE_SEGURO=true
    TRUST_PROXY=true
    ```
  - Realize backups periódicos do arquivo `dados/telemetria.db` e do arquivo `dados/chave.secreta`.

---

## 9. Comandos de Emergência (CLI)

Se o administrador perder o dispositivo configurado com o 2FA ou esquecer a senha, é possível intervir diretamente pelo terminal do servidor sem depender da interface web:

```bash
cd dashboard_web

# Resetar o 2FA de um usuário (força nova leitura de QR Code no próximo login):
npm run admin -- resetar-2fa admin@local

# Redefinir senha (gera nova senha provisória exibida no terminal):
npm run admin -- redefinir-senha admin@local

# Desbloquear usuário após excesso de falhas:
npm run admin -- desbloquear cliente@exemplo.com

# Listar todos os usuários cadastrados e situação de 2FA:
npm run admin -- listar
```

---

## 10. Licença e Autoria

Este projeto é disponibilizado sob a licença **MIT**, podendo ser utilizado, estudado e adaptado livremente para fins educacionais, comerciais ou industriais.
