/*
 ============================================================================
  PROJETO: Telemetria de Energia — Finder 7M.38 Simulado no ESP32
  ARQUIVO: esp32_medidor_7m38_wifi.ino
  PLACA:   ESP32 Dev Module (ou similar com Wi-Fi 2.4 GHz)

  OBJETIVO:
  Simular o medidor de energia Finder 7M.38 e o papel do controlador OPTA,
  enviando leituras via Wi-Fi/Internet para um Broker MQTT público sem cabo.

  ARQUITETURA DESTE SKETCH:
  - LADO "MEDIDOR SIMULADO":
      Armazena valores elétricos fictícios em vetores de 16 bits imitando
      a tabela de registradores Modbus do Finder 7M.38 (função 04, float32
      IEEE-754 ocupando 2 registradores consecutivos, palavra alta primeiro).
      Atualiza as grandezas elétricas a cada 1 segundo.
  - LADO "OPTA (GATEWAY)":
      Lê os registradores através da função 'lerRegistrador(endereco)',
      recompõe os floats com 'lerFloat(endereco)', empacota em JSON e
      publica via MQTT a cada 5 segundos.
      *Na instalação real com Arduino OPTA, apenas a função 'lerRegistrador'
      será adaptada para realizar a leitura Modbus RTU real via RS-485.*

  BIBLIOTECAS NECESSÁRIAS:
  - WiFi.h (inclusa no pacote de placas ESP32 para Arduino IDE)
  - PubSubClient por Nick O'Leary (instalar via Gerenciador de Bibliotecas)
 ============================================================================
*/

#include <WiFi.h>
#include <PubSubClient.h>
#include <time.h>

// ============================================================================
// 1. CONFIGURAÇÕES DO USUÁRIO
// ============================================================================

#define LED_PIN 2  // Pino do LED (comum em ESP32 DevKit)

// Senhas e dados sensíveis ficam no arquivo "segredos.h" (que NÃO vai para o
// GitHub nem é compartilhado). Na primeira vez, copie "segredos.exemplo.h"
// para "segredos.h" e preencha com os dados da sua rede e do seu broker.
//   - WIFI_SSID / WIFI_SENHA  -> rede Wi-Fi (o ESP32 só funciona em 2,4 GHz)
//   - MQTT_USUARIO / MQTT_SENHA -> deixe "" para o broker público de teste
#include "segredos.h"

// Configurações do Broker MQTT
const char* MQTT_HOST     = "broker.hivemq.com"; // Broker público HiveMQ (só para TESTE)
const int   MQTT_PORTA    = 1883;                // Porta padrão sem criptografia

// IMPORTANTE: Escolha um prefixo exclusivo para você.
// Como o broker HiveMQ é público e compartilhado mundialmente, se duas pessoas
// usarem o mesmo prefixo os dados irão colidir. Exemplo: "joao_telemetria_88"
const char* PREFIXO       = "meu_projeto_energia_123";

// Identificadores do sistema
const char* GATEWAY_ID    = "esp32sim";          // ID do gateway. O OPTA real usa "opta01":
                                                 // nomes diferentes evitam misturar os contadores
const int   SLAVE_ID      = 33;                  // ID Modbus do medidor Finder 7M.38
const unsigned long INTERVALO_MS = 5000;         // Intervalo de envio MQTT (5 segundos)

// ============================================================================
// 2. MEMÓRIA DO MEDIDOR SIMULADO (FINDER 7M.38)
// ============================================================================
// Mapeamento em 3 faixas de registradores Modbus de 16 bits (uint16_t):
// - Faixa 1 (2498 a 2531): Frequência, Tensão U1, Corrente I1, Potência P1 (34 registradores)
// - Faixa 2 (2554 a 2555): Fator de Potência PF1 (2 registradores)
// - Faixa 3 (2752 a 2753): Totalizador de Energia n1 em Wh (2 registradores)

#define REG_INICIO_F1 2498
#define REG_FIM_F1    2531
#define TAM_FAIXA1    (REG_FIM_F1 - REG_INICIO_F1 + 1) // 34 registradores

#define REG_INICIO_F2 2554
#define REG_FIM_F2    2555
#define TAM_FAIXA2    (REG_FIM_F2 - REG_INICIO_F2 + 1) // 2 registradores

#define REG_INICIO_F3 2752
#define REG_FIM_F3    2753
#define TAM_FAIXA3    (REG_FIM_F3 - REG_INICIO_F3 + 1) // 2 registradores

uint16_t memoriaFaixa1[TAM_FAIXA1];
uint16_t memoriaFaixa2[TAM_FAIXA2];
uint16_t memoriaFaixa3[TAM_FAIXA3];

// Valor persistente do totalizador de energia (começa em 1.500.000 Wh e nunca diminui)
// IMPORTANTE: precisa ser "double". Com "float" (7 dígitos de precisão), somar
// pedacinhos de ~0,2 Wh a um número grande como 1.500.000 perde a fração:
// em 1 dia o contador registrava cerca de 25% A MENOS. O registrador continua
// sendo float32 (igual ao medidor real); só o acumulador interno é double.
static double energiaAcumuladaWh = 1500000.0;

// ============================================================================
// 3. OBJETOS DE REDE E CONTROLE DE TEMPO
// ============================================================================
WiFiClient   espClient;
PubSubClient mqttClient(espClient);

unsigned long ultimoTempoSimulacao = 0; // Controle do ciclo de 1 s do medidor
unsigned long ultimoTempoEnvio     = 0; // Controle do ciclo de 5 s do MQTT
unsigned long ultimaTentativaMqtt  = 0; // Controle de reconexão não bloqueante

// Tópicos MQTT dinâmicos (montados no setup)
String topicoStatus;
String topicoLeitura;
String clientIdMqtt;

// ============================================================================
// 4. FUNÇÕES DO LADO "MEDIDOR" (SIMULAÇÃO MODBUS)
// ============================================================================

/**
 * Retorna o ponteiro para a posição de memória correspondente ao endereço Modbus.
 * Se o endereço não pertencer a nenhuma faixa simulada, retorna nullptr.
 */
uint16_t* obterPonteiroRegistrador(uint16_t endereco) {
  if (endereco >= REG_INICIO_F1 && endereco <= REG_FIM_F1) {
    return &memoriaFaixa1[endereco - REG_INICIO_F1];
  } else if (endereco >= REG_INICIO_F2 && endereco <= REG_FIM_F2) {
    return &memoriaFaixa2[endereco - REG_INICIO_F2];
  } else if (endereco >= REG_INICIO_F3 && endereco <= REG_FIM_F3) {
    return &memoriaFaixa3[endereco - REG_INICIO_F3];
  }
  return nullptr;
}

/**
 * Grava um float32 (IEEE-754) em dois registradores Modbus de 16 bits consecutivos.
 * Conforme o Finder 7M.38: Palavra Mais Significativa (MSW) primeiro no 'endereco',
 * e Palavra Menos Significativa (LSW) no 'endereco + 1'.
 */
void medidorGravaFloat(uint16_t endereco, float valor) {
  uint32_t bits = 0;
  memcpy(&bits, &valor, sizeof(float));

  // Separação em duas palavras de 16 bits
  uint16_t msw = (uint16_t)((bits >> 16) & 0xFFFF);
  uint16_t lsw = (uint16_t)(bits & 0xFFFF);

  uint16_t* ptrMsw = obterPonteiroRegistrador(endereco);
  uint16_t* ptrLsw = obterPonteiroRegistrador(endereco + 1);

  if (ptrMsw != nullptr) {
    *ptrMsw = msw;
  }
  if (ptrLsw != nullptr) {
    *ptrLsw = lsw;
  }
}

/**
 * Gera um número float pseudoaleatório dentro de uma faixa [minVal, maxVal].
 */
float geraFloatAleatorio(float minVal, float maxVal) {
  float escala = (float)random(0, 10001) / 10000.0f;
  return minVal + (escala * (maxVal - minVal));
}

/**
 * Atualiza os registradores simulados do medidor a cada 1 segundo.
 */
void atualizarSimulacaoMedidor() {
  // 1. Gera grandezas dentro das faixas especificadas pelo Finder 7M.38
  float frequencia = geraFloatAleatorio(59.95f, 60.05f); // 59,95 a 60,05 Hz
  float tensao     = geraFloatAleatorio(124.0f, 130.0f); // 124 a 130 V
  float corrente   = geraFloatAleatorio(2.0f, 8.0f);     // 2 a 8 A
  float fp         = geraFloatAleatorio(0.92f, 0.98f);   // 0,92 a 0,98

  // Potência ativa P1 (W) = Tensão × Corrente × Fator de Potência
  float potencia = tensao * corrente * fp;

  // Contador de energia n1 (Wh): soma potência × segundos ÷ 3600 (a cada 1 segundo)
  energiaAcumuladaWh += (double)potencia / 3600.0;

  // 2. Grava nos registradores simulados (lado medidor)
  medidorGravaFloat(2498, frequencia);         // Reg 2498-2499: Frequência
  medidorGravaFloat(2500, tensao);             // Reg 2500-2501: Tensão U1
  medidorGravaFloat(2516, corrente);           // Reg 2516-2517: Corrente I1
  medidorGravaFloat(2530, potencia);           // Reg 2530-2531: Potência P1
  medidorGravaFloat(2554, fp);                 // Reg 2554-2555: Fator de Potência PF1
  medidorGravaFloat(2752, (float)energiaAcumuladaWh); // Reg 2752-2753: Energia n1 (Wh)
}

// ============================================================================
// 5. FUNÇÕES DO LADO "OPTA" (LEITURA E CONVERSÃO)
// ============================================================================

/**
 * Lê um único registrador Modbus de 16 bits.
 * NOTA DE MIGRAÇÃO PARA O ARDUINO OPTA:
 * No código final do OPTA, substitua esta função para executar a leitura real
 * Modbus RTU via RS-485 (ex: ModbusRTUClient.readHoldingRegisters / readInputRegisters).
 */
uint16_t lerRegistrador(uint16_t endereco) {
  uint16_t* ptr = obterPonteiroRegistrador(endereco);
  if (ptr != nullptr) {
    return *ptr;
  }
  return 0; // Registrador inexistente
}

/**
 * Lê dois registradores de 16 bits e recompõe o número float de 32 bits (IEEE-754).
 * Palavra alta no 'endereco', palavra baixa no 'endereco + 1'.
 */
float lerFloat(uint16_t endereco) {
  uint16_t msw = lerRegistrador(endereco);
  uint16_t lsw = lerRegistrador(endereco + 1);

  uint32_t bits = ((uint32_t)msw << 16) | (uint32_t)lsw;
  float valor = 0.0f;
  memcpy(&valor, &bits, sizeof(float));
  return valor;
}

// ============================================================================
// 6. UTILITÁRIOS: TEMPO NTP & ISO-8601
// ============================================================================

/**
 * Retorna o timestamp atual em UTC no formato ISO-8601 ("2026-10-16T22:50:00Z").
 * Se o relógio do ESP32 ainda não tiver sincronizado com o NTP, retorna "null".
 */
String obterTimestampISO8601() {
  time_t agora = time(nullptr);
  // Se o ano for anterior a 2024 (timestamp < 1700000000), o NTP ainda não respondeu
  if (agora < 1700000000) {
    return "null";
  }

  struct tm timeinfo;
  gmtime_r(&agora, &timeinfo);

  char buffer[32];
  // Formato com aspas incluídas para o JSON: "AAAA-MM-DDTHH:MM:SSZ"
  strftime(buffer, sizeof(buffer), "\"%Y-%m-%dT%H:%M:%SZ\"", &timeinfo);
  return String(buffer);
}

// ============================================================================
// 7. GERENCIAMENTO DE REDE E MQTT
// ============================================================================

void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(LED_PIN, HIGH);
    return;
  }

  Serial.println();
  Serial.print("[Wi-Fi] Conectando a rede: ");
  Serial.println(WIFI_SSID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_SENHA);

  int tentativas = 0;
  while (WiFi.status() != WL_CONNECTED && tentativas < 30) {
    digitalWrite(LED_PIN, !digitalRead(LED_PIN)); // Pisca o LED enquanto tenta conectar
    delay(500);
    Serial.print(".");
    tentativas++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    digitalWrite(LED_PIN, HIGH); // LED fica aceso fixo após conexão
    Serial.println();
    Serial.println("[Wi-Fi] Conectado com sucesso!");
    Serial.print("[Wi-Fi] Endereço IP obtido: ");
    Serial.println(WiFi.localIP());

    // Inicia sincronização de relógio via NTP (UTC sem fuso horário)
    configTime(0, 0, "pool.ntp.org", "time.google.com");
  } else {
    digitalWrite(LED_PIN, LOW); // LED apagado se falhar a conexão
    Serial.println();
    Serial.println("[Wi-Fi] Não foi possível conectar. Verifique SSID/Senha (2.4 GHz apenas).");
  }
}

void conectarMQTT() {
  if (WiFi.status() != WL_CONNECTED) {
    return;
  }

  if (mqttClient.connected()) {
    return;
  }

  unsigned long agora = millis();
  // Tenta reconectar a cada 5 segundos sem travar o processador
  if (agora - ultimaTentativaMqtt < 5000) {
    return;
  }
  ultimaTentativaMqtt = agora;

  Serial.print("[MQTT] Conectando ao broker: ");
  Serial.print(MQTT_HOST);
  Serial.print(":");
  Serial.println(MQTT_PORTA);

  // Configura LWT (Last Will and Testament):
  // Se o ESP32 perder a conexão abruptamente, o broker publicará "offline" retido no tópico de status
  const char* lwtTopico  = topicoStatus.c_str();
  const int   lwtQoS     = 1;
  const bool  lwtRetain  = true;
  const char* lwtMensagem = "offline";

  // Usuário/senha do broker (vazios = broker público sem autenticação)
  const char* usuario = (strlen(MQTT_USUARIO) > 0) ? MQTT_USUARIO : nullptr;
  const char* senha   = (strlen(MQTT_SENHA)   > 0) ? MQTT_SENHA   : nullptr;

  if (mqttClient.connect(clientIdMqtt.c_str(), usuario, senha, lwtTopico, lwtQoS, lwtRetain, lwtMensagem)) {
    Serial.println("[MQTT] Conectado ao broker!");
    Serial.print("[MQTT] Client ID: ");
    Serial.println(clientIdMqtt);

    // Publica status "online" (retido) no tópico de status do gateway
    mqttClient.publish(topicoStatus.c_str(), "online", true);
    Serial.print("[MQTT] Status 'online' publicado em: ");
    Serial.println(topicoStatus);
  } else {
    Serial.print("[MQTT] Falha na conexão. Código de erro rc=");
    Serial.println(mqttClient.state());
  }
}

/**
 * Função executada pelo "lado OPTA" a cada 5 segundos para ler o medidor
 * e enviar a telemetria empacotada em JSON.
 */
void publicarTelemetria() {
  // Lê os dados através da camada de registradores
  float frequencia = lerFloat(2498);
  float tensao     = lerFloat(2500);
  float corrente   = lerFloat(2516);
  float potencia   = lerFloat(2530);
  float fp         = lerFloat(2554);
  float energiaWh  = lerFloat(2752);

  // Converte a energia de Wh para kWh
  float energiaKwh = energiaWh / 1000.0f;

  // Obtém o timestamp ISO-8601 (já formatado com aspas ou literal null)
  String ts = obterTimestampISO8601();

  // Monta o JSON conforme a especificação do projeto
  char payload[512];
  snprintf(payload, sizeof(payload),
    "{\"ts\":%s,\"slave_id\":%d,\"modelo\":\"FINDER_7M38\",\"ok\":true,"
    "\"valores\":{\"tensao_v\":%.2f,\"corrente_a\":%.3f,\"potencia_w\":%.1f,\"fp\":%.3f,"
    "\"frequencia_hz\":%.2f,\"energia_kwh\":%.3f},\"erros\":[]}",
    ts.c_str(),
    SLAVE_ID,
    tensao,
    corrente,
    potencia,
    fp,
    frequencia,
    energiaKwh
  );

  // Envia via MQTT
  bool sucesso = mqttClient.publish(topicoLeitura.c_str(), payload);

  if (sucesso) {
    Serial.print("[enviado] ");
  } else {
    Serial.print("[FALHA]   ");
  }
  Serial.print(topicoLeitura);
  Serial.print(" -> ");
  Serial.println(payload);
}

// ============================================================================
// 8. SETUP & LOOP PRINCIPAL
// ============================================================================

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println();
  Serial.println("=================================================");
  Serial.println("   SIMULADOR FINDER 7M.38 + OPTA VIA MQTT (ESP32)");
  Serial.println("=================================================");

  // Configuração do LED indicador de status de conexão
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  // Gera semente aleatória com base no ruído do pino analógico desconectado
  randomSeed(analogRead(34));

  // Inicializa memória do medidor simulado com zeros
  memset(memoriaFaixa1, 0, sizeof(memoriaFaixa1));
  memset(memoriaFaixa2, 0, sizeof(memoriaFaixa2));
  memset(memoriaFaixa3, 0, sizeof(memoriaFaixa3));

  // Primeira carga de valores para o medidor
  atualizarSimulacaoMedidor();

  // Conecta ao Wi-Fi
  conectarWiFi();

  // Gera Client ID único com base no MAC Address do ESP32
  String mac = WiFi.macAddress();
  mac.replace(":", "");
  clientIdMqtt = "esp32-sim-" + mac;

  // Constrói os tópicos MQTT com o prefixo
  topicoStatus  = String(PREFIXO) + "/telemetria/" + GATEWAY_ID + "/status";
  topicoLeitura = String(PREFIXO) + "/telemetria/" + GATEWAY_ID + "/medidor/" + String(SLAVE_ID);

  // Configurações do cliente MQTT
  mqttClient.setServer(MQTT_HOST, MQTT_PORTA);
  mqttClient.setBufferSize(512); // Buffer ampliado para suportar o payload JSON completo

  Serial.print("[INFO] Tópico de Status:  ");
  Serial.println(topicoStatus);
  Serial.print("[INFO] Tópico de Leitura: ");
  Serial.println(topicoLeitura);
}

void loop() {
  unsigned long agora = millis();

  // Garante a conexão Wi-Fi ativa
  if (WiFi.status() != WL_CONNECTED) {
    conectarWiFi();
  } else {
    digitalWrite(LED_PIN, HIGH); // Garante LED ligado continuamente conectado
    // Garante a conexão MQTT ativa
    if (!mqttClient.connected()) {
      conectarMQTT();
    }
  }

  // Mantém a máquina de estados do PubSubClient rodando
  mqttClient.loop();

  // RITMO 1: Lado "medidor" atualiza registradores a cada 1 segundo (1000 ms)
  if (agora - ultimoTempoSimulacao >= 1000) {
    ultimoTempoSimulacao = agora;
    atualizarSimulacaoMedidor();
  }

  // RITMO 2: Lado "OPTA" publica telemetria a cada 5 segundos (5000 ms)
  if (agora - ultimoTempoEnvio >= INTERVALO_MS) {
    ultimoTempoEnvio = agora;
    if (mqttClient.connected()) {
      publicarTelemetria();
    } else {
      Serial.println("[MQTT] Leitura não enviada: Broker desconectado no momento.");
    }
  }
}
