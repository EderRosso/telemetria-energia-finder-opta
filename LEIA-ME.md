# Telemetria de Energia: Finder 7M.38 Simulado no ESP32 → MQTT → PC

> **Versão 2 (17/10/2026)**
> - **Site com login verificado** (senha + código do Google/Microsoft Authenticator), painel do
>   administrador (tarifa, clientes, medidores, faturamento, usuários) e painel do cliente
>   (consumo e valor do mês). Veja `dashboard_web/LEIA-ME-WEB.md`.
> - **ESP32:** contador de energia corrigido (o acumulador `float` perdia ~25% da energia por dia;
>   agora é `double`) e senhas movidas para `segredos.h`.
> - O `receptor_pc` continua útil só como ferramenta de diagnóstico do MQTT.

Este projeto implementa um ambiente de testes completo para transmissão de leituras elétricas **pela internet sem fio**, simulando o comportamento de um medidor de energia **Finder 7M.38** integrado a um gateway **Arduino OPTA**, transmitindo telemetria para um receptor em Python no computador via broker MQTT público.

---

## 1. Arquitetura da Solução

```
+───────────────────────────────────────────────────────────────+
|                  ESP32 (Dev Module com Wi-Fi)                 |
|                                                               |
|  [Lado "Medidor Simulado"]            [Lado "OPTA / Gateway"] |
|  - Mapeamento Modbus 7M.38            - lerRegistrador()      |
|  - Registradores de 16 bits           - lerFloat()            |
|  - Atualização a cada 1 s             - JSON + MQTT a cada 5s |
+───────────────────────────────┬───────────────────────────────+
                                │ Wi-Fi 2.4 GHz / Internet
                                ▼
                 +─────────────────────────────+
                 |   Broker MQTT (HiveMQ)      |
                 |   broker.hivemq.com:1883    |
                 +──────────────┬──────────────+
                                │ Internet
                                ▼
                 +─────────────────────────────+
                 |       Receptor PC           |
                 |    receptor_mqtt.py         |
                 +─────────────────────────────+
```

### Como a separação funciona
No projeto final com hardware real:
- O medidor **Finder 7M.38** se comunicará por cabo **RS-485 (Modbus RTU)** direto com o **Arduino OPTA**.
- O **Arduino OPTA** se conectará à rede e publicará no MQTT.

No ESP32, essa arquitetura foi reproduzida internamente:
- **Lado "medidor":** grava os valores elétricos nos vetores de registradores de 16 bits seguindo à risca a memória do Finder 7M.38.
- **Lado "OPTA":** consulta a memória chamando `lerRegistrador(endereco)` e recompõe o float com `lerFloat(endereco)`.
- **Migração futura:** Quando você estiver com o Arduino OPTA real em mãos, **somente a função `lerRegistrador(endereco)` precisará ser alterada** para fazer a requisição Modbus RTU real (`ModbusRTUClient`). Todo o empacotamento JSON e envio MQTT já está pronto.

---

## 2. Mapa de Registradores do Finder 7M.38

O medidor Finder 7M.38 armazena grandezas no formato **IEEE-754 float32** ocupando **2 registradores consecutivos de 16 bits**, com a **palavra mais significativa primeiro (MSW / Big-endian Word Order)**, acessível via **Função Modbus 04** (Input Registers).

| Grandeza | Endereço Modbus | Registradores (16 bits) | Unidade | Faixa Simulada |
|---|---|---|---|---|
| **Frequência** | 2498 | 2498 (MSW) e 2499 (LSW) | Hz | 59,95 a 60,05 |
| **Tensão U1** | 2500 | 2500 (MSW) e 2501 (LSW) | V | 124,0 a 130,0 |
| **Corrente I1** | 2516 | 2516 (MSW) e 2517 (LSW) | A | 2,0 a 8,0 |
| **Potência ativa P1** | 2530 | 2530 (MSW) e 2531 (LSW) | W | Tensão × Corrente × FP |
| **Fator de potência PF1** | 2554 | 2554 (MSW) e 2555 (LSW) | — | 0,92 a 0,98 |
| **Contador de energia n1** | 2752 | 2752 (MSW) e 2753 (LSW) | **Wh** | Inicia em 1.500.000 Wh e soma `P × s / 3600` |

*Nota: Na instalação física real, o Finder 7M.38 vem configurado de fábrica com: ID Modbus 33, 19200 bps, 8N2.*

---

## 3. Tópicos MQTT e Estrutura dos Dados

### Tabela de Tópicos
| Finalidade | Tópico | QoS | Retido | Exemplo de Conteúdo |
|---|---|:---:|:---:|---|
| **Status do Gateway (LWT)** | `{PREFIXO}/telemetria/{GATEWAY_ID}/status` | 1 | Sim | `online` (ao conectar) ou `offline` (queda/LWT) |
| **Leitura do Medidor** | `{PREFIXO}/telemetria/{GATEWAY_ID}/medidor/{SLAVE_ID}` | 0 | Não | Payload JSON com grandezas |

*Valores padrão do código:*
- `{GATEWAY_ID}` = `opta01`
- `{SLAVE_ID}` = `33`

### Exemplo de JSON Enviado a Cada 5 Segundos
A energia lida do registrador em **Wh** é convertida para **kWh** no envio:
```json
{
  "ts": "2026-10-16T22:50:00Z",
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
*(Se o ESP32 ainda não tiver sincronizado o relógio via NTP, o campo `"ts"` será enviado como `null`)*.

---

## 4. Passo a Passo de Instalação e Execução

### Passo 1: Preparar a IDE Arduino para o ESP32
1. Abra a **Arduino IDE** (versão 2.x recomendada).
2. Se ainda não tiver o suporte a ESP32 instalado:
   - Acesse **Arquivo > Preferências**.
   - No campo *URLs do Gerenciador de Placas Adicionais*, adicione:
     ```text
     https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
     ```
   - Vá em **Ferramentas > Placa > Gerenciador de Placas**, pesquise por `esp32` (por Espressif Systems) e clique em **Instalar**.
3. Instale a biblioteca **PubSubClient**:
   - Vá em **Ferramentas > Gerenciar Bibliotecas...** (ou atalho `Ctrl + Shift + I`).
   - Pesquise por `PubSubClient` (por Nick O'Leary) e clique em **Instalar**.

### Passo 2: Configurar e Gravar o ESP32
1. Abra o arquivo `esp32_medidor_7m38_wifi/esp32_medidor_7m38_wifi.ino`.
2. Copie `segredos.exemplo.h` para `segredos.h` (na mesma pasta) e preencha a rede Wi-Fi.
   O `segredos.h` guarda as senhas e **não deve ser compartilhado** (já está no `.gitignore`):
   ```cpp
   const char* WIFI_SSID    = "NOME_DO_SEU_WIFI";   // Sua rede (apenas 2.4 GHz)
   const char* WIFI_SENHA   = "SENHA_DO_SEU_WIFI";  // Senha da rede
   const char* MQTT_USUARIO = "";                   // vazio no broker público de teste
   const char* MQTT_SENHA   = "";
   ```
   No `.ino`, confira o prefixo (precisa ser igual ao do servidor web):
   ```cpp
   const char* PREFIXO    = "meu_projeto_energia_123"; // Escolha um nome exclusivo!
   ```
3. Conecte o ESP32 ao computador via cabo USB.
4. Selecione a placa: **Ferramentas > Placa > esp32 > ESP32 Dev Module** (ou o modelo correspondente à sua placa).
5. Selecione a **Porta COM** correta em **Ferramentas > Porta**.
6. Clique em **Carregar (Upload)**.
7. Abra o **Monitor Serial** configurado em **115200 bps** para acompanhar o processo:
   - Você verá a conexão com o Wi-Fi, o endereço IP atribuído, a conexão ao broker e as leituras sendo publicadas com o prefixo `[enviado]`.

> **Dica de Mobilidade:** Uma vez gravado o código, o ESP32 **não precisa mais do computador**. Você pode desconectá-lo e ligá-lo em qualquer carregador de celular de 5V na tomada. Ele continuará lendo, incrementando a energia e publicando na nuvem.

### Passo 3: Executar o Receptor Python no PC
1. Abra um terminal (PowerShell, Prompt de Comando ou Bash) e entre na pasta `receptor_pc`:
   ```bash
   cd receptor_pc
   ```
2. Instale as dependências:
   ```bash
   pip install -r requirements.txt
   ```
3. Execute o script passando o mesmo prefixo configurado no ESP32:
   ```bash
   python receptor_mqtt.py --prefixo meu_projeto_energia_123
   ```
4. O terminal exibirá as mensagens formatadas em tempo real:
   ```text
   ================================================================================
         RECEPTOR DE TELEMETRIA MQTT — MEDIDOR FINDER 7M.38 (SIMULADO)
   ================================================================================
   Broker:  broker.hivemq.com:1883
   Prefixo: meu_projeto_energia_123
   ================================================================================
   [INICIANDO] Conectando ao broker 'broker.hivemq.com:1883'...
   [CONECTADO] Conectado com sucesso ao broker 'broker.hivemq.com:1883'.
   [INSCRITO] Assinando tópico: meu_projeto_energia_123/telemetria/#
   --------------------------------------------------------------------------------
   STATUS do gateway: ONLINE
   19:50:56 [ID 33] Tensao: 126.8 V | Corrente: 4.82 A | Potencia: 585 W | FP: 0.96 | Frequencia: 60.01 Hz | Energia: 1500.002 kWh
   19:51:01 [ID 33] Tensao: 125.4 V | Corrente: 5.12 A | Potencia: 610 W | FP: 0.95 | Frequencia: 59.98 Hz | Energia: 1500.003 kWh
   ```
5. Para encerrar o receptor, pressione `Ctrl + C`.

---

## 5. Como Testar o LWT (Last Will and Testament)

1. Com o receptor Python rodando no PC, retire o ESP32 da tomada (ou desconecte o cabo de alimentação abruptamente).
2. Em aproximadamente **15 a 30 segundos** (tempo de expiração do keepalive do broker MQTT), o receptor exibirá:
   ```text
   STATUS do gateway: OFFLINE
   ```
3. Ao ligar o ESP32 novamente na tomada, assim que ele reconectar, o receptor exibirá:
   ```text
   STATUS do gateway: ONLINE
   ```
   e as leituras voltarão a chegar a cada 5 segundos, com a energia acumulada continuando a partir do valor anterior.

---

## 6. Problemas Comuns e Diagnóstico (Troubleshooting)

| Sintoma | Causa Mais Provável | Solução |
|---|---|---|
| **ESP32 não conecta no Wi-Fi** (pontos infinitos no Monitor Serial) | O roteador está transmitindo apenas em 5 GHz. O ESP32 só suporta **Wi-Fi 2.4 GHz**. | Verifique se sua rede Wi-Fi possui a banda 2.4 GHz habilitada com SSID separado ou teste compartilhando a conexão 2.4 GHz do seu smartphone. |
| **Erro `MQTT rc=-2` no Monitor Serial** ou receptor Python não conecta | Bloqueio de rede na porta TCP 1883 (comum em redes corporativas ou roteadores com firewall rígido). | Teste conectar o PC e o ESP32 no ponto de acesso (roteador) 4G/5G do celular para validar se o provedor bloqueia a porta 1883. |
| **ESP32 mostra `[enviado]`, mas o Python não recebe nada** | Prefixo diferente entre os dois lados. | Certifique-se de que o parâmetro `--prefixo` no terminal seja **exatamente igual** ao valor da constante `PREFIXO` definida no arquivo `.ino`. |
| **Recebendo mensagens estranhas de outros dispositivos** | Prefixo genérico colidindo com outros usuários do HiveMQ público. | Altere o `PREFIXO` para algo longo e exclusivo (ex: `antonio_finder_2026_xyz`). |
| **Erro ao carregar código para o ESP32 (Timed out waiting for packet header)** | Placa ESP32 exige acionamento manual do modo bootload. | Ao iniciar a mensagem "Connecting.....", segure o botão **BOOT** da placa até iniciar a gravação. |

---

## 7. Aviso Importante de Segurança

> [!WARNING]
> O broker público `broker.hivemq.com` é um serviço gratuito e aberto mundialmente, destinado **exclusivamente para testes e aprendizado com dados fictícios**. Qualquer pessoa na internet pode ler e publicar nos tópicos.
>
> Para a instalação definitiva com o **Arduino OPTA** e dados reais de consumo:
> - Utilize um broker MQTT privado (ex.: Eclipse Mosquitto em servidor local ou VPS própria).
> - Ative criptografia **TLS/SSL (porta 8883)**.
> - Configure autenticação com **usuário e senha fortes** e restrinja as permissões de acesso por tópico (ACL).
