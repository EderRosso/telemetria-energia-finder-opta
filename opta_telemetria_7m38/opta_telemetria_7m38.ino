/*
 ============================================================================
  PROJETO: Telemetria de Energia — PROGRAMA DEFINITIVO DO OPTA
  ARQUIVO: opta_telemetria_7m38.ino
  PLACA:   Finder OPTA Plus 8A.04-8310 (Arduino Opta RS485) — porta Ethernet
           Na IDE: Ferramentas > Placa > Arduino Mbed OS Opta Boards > Opta

  O QUE FAZ:
   1. Lê os medidores Finder 7M.38 pelo RS-485 (Modbus RTU, mestre = OPTA).
   2. Publica as leituras por MQTT pela porta Ethernet, no MESMO formato
      (tópicos e JSON) do ESP32 de testes. O servidor/site não muda nada.

  BASE: exemplos oficiais da Finder (github.com/Engenharia-Finder):
   - OPTA-PROG-MODBUS7M-PROGFINDER  -> leitura Modbus do 7M (19200 8N2, FC 04)
   - OPTA-PROG-MODBUS7M-PROGARDUINO -> contador de energia n1 em 0xAC0 (2752)
   - OPTA-PROG-MQTT                 -> MQTT com PubSubClient
  Diferença importante em relação ao exemplo de MQTT da Finder: aqui NADA
  trava esperando a rede. Se a internet ou o broker caírem, o OPTA continua
  lendo os medidores e tenta reconectar a cada 5 s.

  BIBLIOTECAS (Gerenciador de Bibliotecas da IDE):
   - ArduinoModbus  (Arduino)        - ArduinoRS485 (Arduino)
   - PubSubClient   (Nick O'Leary)
   Ethernet/PortentaEthernet já vêm com o pacote de placas "Arduino Mbed OS Opta Boards".

  LEDs DO PAINEL FRONTAL:
   D0 = Ethernet com cabo e IP   D1 = MQTT conectado
   D2 = todos os medidores responderam na última leitura
   D3 = pisca a cada publicação
 ============================================================================
*/

#include <ArduinoRS485.h>
#include <ArduinoModbus.h>
#include <PortentaEthernet.h>
#include <Ethernet.h>
#include <EthernetUdp.h>
#include <PubSubClient.h>
#include <mbed.h>

#include <time.h>

// Senhas ficam em "segredos.h" (copie de segredos.exemplo.h). Não compartilhe.
#include "segredos.h"

// ============================================================================
// 1. CONFIGURAÇÕES
// ============================================================================

// ---------- MQTT (precisa bater com o .env do servidor) ----------
const char* MQTT_HOST  = "broker.hivemq.com";   // teste; produção: seu broker
const int   MQTT_PORTA = 1883;                  // 8883 se USAR_TLS = 1
#define USAR_TLS 0                              // 1 = MQTT criptografado (mqtts)
const char* PREFIXO    = "meu_projeto_energia_123";
const char* GATEWAY_ID = "opta01";

// ---------- Medidores no barramento RS-485 ----------
// Coloque aqui o ID Modbus de cada 7M.38 (todos com a mesma serial: 19200 8N2)
const uint8_t MEDIDORES[] = { 33 };
const uint8_t QTD_MEDIDORES = sizeof(MEDIDORES) / sizeof(MEDIDORES[0]);

const unsigned long BAUD_MODBUS        = 19200;
const unsigned long INTERVALO_LEITURA  = 5000;   // ms entre ciclos de leitura/publicação
const unsigned long TIMEOUT_MODBUS_MS  = 500;    // espera da resposta de cada medidor

// ---------- Rede ----------
// 0 = DHCP (o roteador dá o IP)   1 = IP fixo (preencha abaixo)
#define USAR_IP_FIXO 0
IPAddress IP_FIXO(192, 168, 0, 50);
IPAddress DNS_FIXO(8, 8, 8, 8);
IPAddress GATEWAY_FIXO(192, 168, 0, 1);
IPAddress MASCARA_FIXA(255, 255, 255, 0);

// Reinicia o OPTA sozinho se o programa travar por mais de 30 s
#define USAR_WATCHDOG 1

// ============================================================================
// 2. MAPA DE REGISTRADORES DO FINDER 7M.38
//    Função 04 (input registers), float32 IEEE-754 em 2 registradores,
//    palavra mais significativa primeiro. Endereços conferidos com a tabela
//    do manual e com os exemplos oficiais da Finder.
// ============================================================================
const uint16_t REG_POTENCIA_TOTAL = 2490;  // 0x9BA  Active Power Total (W)
const uint16_t REG_FREQUENCIA     = 2498;  // 0x9C2  Frequency (Hz)
const uint16_t REG_TENSAO_U1      = 2500;  // 0x9C4  U1 (V)
const uint16_t REG_CORRENTE_I1    = 2516;  // 0x9D4  I1 (A)
const uint16_t REG_FP1            = 2554;  // 0x9FA  Power Factor Phase 1
const uint16_t REG_ENERGIA_N1     = 2752;  // 0xAC0  Contador de energia n1 (Wh) — BASE DA COBRANÇA

// ============================================================================
// 3. OBJETOS GLOBAIS
// ============================================================================
#if USAR_TLS
  #include <EthernetSSLClient.h>
  EthernetSSLClient clienteRede;   // usa os certificados raiz embutidos no OPTA
#else
  EthernetClient clienteRede;
#endif
PubSubClient mqtt(clienteRede);
EthernetUDP udpNtp;

String clientId;
String topicoStatus;
bool redeOk = false;

unsigned long ultimaLeitura        = 0;
unsigned long ultimaTentativaMqtt  = 0;
unsigned long ultimaTentativaRede  = 0;
unsigned long ultimaSincronizacao  = 0;
unsigned long desligarLedPublicacao = 0;

struct Leitura {
  bool  ok;
  float tensao, corrente, potencia, fp, frequencia, energiaWh;
};

// ============================================================================
// 4. MODBUS RTU — leitura do 7M.38
// ============================================================================

/**
 * Lê um float (2 registradores) do medidor. Mesma lógica do exemplo oficial
 * da Finder (readdata), usando memcpy para montar o float com segurança.
 */
bool lerFloat(uint8_t idMedidor, uint16_t registrador, float &valor) {
  if (!ModbusRTUClient.requestFrom(idMedidor, INPUT_REGISTERS, registrador, 2)) {
    return false;
  }
  uint16_t alta  = ModbusRTUClient.read();
  uint16_t baixa = ModbusRTUClient.read();
  uint32_t bits  = ((uint32_t)alta << 16) | baixa;
  memcpy(&valor, &bits, sizeof(float));
  return (valor == valor) && fabsf(valor) < 1e12f;  // descarta NaN/infinito
}

Leitura lerMedidor(uint8_t id) {
  Leitura l = { false, 0, 0, 0, 0, 0, 0 };
  // A energia é lida primeiro: é o valor mais importante (cobrança)
  bool ok = lerFloat(id, REG_ENERGIA_N1, l.energiaWh);
  ok = ok && lerFloat(id, REG_TENSAO_U1, l.tensao);
  ok = ok && lerFloat(id, REG_CORRENTE_I1, l.corrente);
  ok = ok && lerFloat(id, REG_POTENCIA_TOTAL, l.potencia);
  ok = ok && lerFloat(id, REG_FP1, l.fp);
  ok = ok && lerFloat(id, REG_FREQUENCIA, l.frequencia);
  l.ok = ok;
  if (!ok) {
    Serial.print("[MODBUS] ID ");
    Serial.print(id);
    Serial.print(" sem resposta: ");
    Serial.println(ModbusRTUClient.lastError());
  }
  return l;
}

// ============================================================================
// 5. HORA (NTP) — para o campo "ts" e para validar certificados TLS
// ============================================================================

/** Consulta o pool.ntp.org (espera no máximo 1,5 s) e acerta o relógio do OPTA. */
void sincronizarRelogio() {
  if (!redeOk) return;
  byte pacote[48] = { 0 };
  pacote[0] = 0b11100011;  // LI, versão 4, modo cliente
  udpNtp.begin(2390);
  if (!udpNtp.beginPacket("pool.ntp.org", 123)) { udpNtp.stop(); return; }
  udpNtp.write(pacote, sizeof(pacote));
  udpNtp.endPacket();

  unsigned long inicio = millis();
  while (millis() - inicio < 1500) {
    if (udpNtp.parsePacket() >= 48) {
      udpNtp.read(pacote, sizeof(pacote));
      unsigned long segundos1900 = ((unsigned long)pacote[40] << 24) | ((unsigned long)pacote[41] << 16) |
                                   ((unsigned long)pacote[42] << 8) | pacote[43];
      unsigned long epoch = segundos1900 - 2208988800UL;  // 1900 -> 1970
      set_time(epoch);
      Serial.print("[NTP] Relógio acertado: ");
      Serial.println(timestampISO());
      break;
    }
    delay(10);
  }
  udpNtp.stop();
  ultimaSincronizacao = millis();
}

/** "2026-10-17T18:30:05Z" entre aspas, ou null se o relógio ainda não foi acertado. */
String timestampISO() {
  time_t agora = time(nullptr);
  if (agora < 1700000000) return "null";
  struct tm t;
  gmtime_r(&agora, &t);
  char buffer[32];
  strftime(buffer, sizeof(buffer), "\"%Y-%m-%dT%H:%M:%SZ\"", &t);
  return String(buffer);
}

// ============================================================================
// 6. REDE (Ethernet) E MQTT — sem travar o programa
// ============================================================================

void conectarRede() {
  Serial.println("[REDE] Iniciando Ethernet...");
#if USAR_IP_FIXO
  int r = Ethernet.begin(IP_FIXO, DNS_FIXO, GATEWAY_FIXO, MASCARA_FIXA);
#else
  int r = Ethernet.begin(nullptr, 15000, 4000);  // DHCP, desiste após 15 s
#endif
  redeOk = (r != 0) && (Ethernet.linkStatus() != LinkOFF);
  if (redeOk) {
    Serial.print("[REDE] Conectado. IP: ");
    Serial.println(Ethernet.localIP());
    sincronizarRelogio();
  } else {
    Serial.println("[REDE] Sem rede (cabo desligado ou DHCP sem resposta). Nova tentativa em 30 s.");
  }
  ultimaTentativaRede = millis();
}

void conectarMqtt() {
  ultimaTentativaMqtt = millis();
  if (clientId.length() == 0) {
    // Identificação única do cliente MQTT, pelo MAC da placa (lido depois da rede subir)
    uint8_t mac[6] = { 0 };
    Ethernet.MACAddress(mac);
    char textoMac[13];
    snprintf(textoMac, sizeof(textoMac), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    clientId = String("opta-") + GATEWAY_ID + "-" + textoMac;
  }
  Serial.print("[MQTT] Conectando a ");
  Serial.print(MQTT_HOST);
  Serial.print(":");
  Serial.println(MQTT_PORTA);

  const char* usuario = strlen(MQTT_USUARIO) ? MQTT_USUARIO : nullptr;
  const char* senha   = strlen(MQTT_SENHA)   ? MQTT_SENHA   : nullptr;

  // LWT: se o OPTA cair, o broker publica "offline" no lugar dele
  if (mqtt.connect(clientId.c_str(), usuario, senha, topicoStatus.c_str(), 1, true, "offline")) {
    mqtt.publish(topicoStatus.c_str(), "online", true);
    Serial.println("[MQTT] Conectado. Status 'online' publicado.");
  } else {
    Serial.print("[MQTT] Falha, rc=");
    Serial.print(mqtt.state());
    Serial.println(" (nova tentativa em 5 s)");
  }
}

/** Mantém rede e MQTT. Nunca fica preso em laço: só tenta de tempos em tempos. */
void manterConexoes() {
  bool cabo = Ethernet.linkStatus() != LinkOFF;
  if (!cabo && redeOk) {
    Serial.println("[REDE] Cabo de rede desconectado.");
    redeOk = false;
  }
  if (!redeOk) {
    if (cabo && millis() - ultimaTentativaRede > 30000) conectarRede();
    return;
  }
  if (!mqtt.connected() && millis() - ultimaTentativaMqtt > 5000) conectarMqtt();
  if (millis() - ultimaSincronizacao > 6UL * 3600UL * 1000UL) sincronizarRelogio();  // a cada 6 h
}

// ============================================================================
// 7. PUBLICAÇÃO — mesmo JSON do ESP32 (contrato do servidor)
// ============================================================================
void publicar(uint8_t id, const Leitura &l) {
  String topico = String(PREFIXO) + "/telemetria/" + GATEWAY_ID + "/medidor/" + String(id);
  String json = "{\"ts\":" + timestampISO() + ",\"slave_id\":" + String(id) + ",\"modelo\":\"FINDER_7M38\",";
  if (l.ok) {
    json += "\"ok\":true,\"valores\":{";
    json += "\"tensao_v\":"      + String(l.tensao, 2);
    json += ",\"corrente_a\":"   + String(l.corrente, 3);
    json += ",\"potencia_w\":"   + String(l.potencia, 1);
    json += ",\"fp\":"           + String(l.fp, 3);
    json += ",\"frequencia_hz\":" + String(l.frequencia, 2);
    json += ",\"energia_kwh\":"  + String(l.energiaWh / 1000.0, 3);
    json += "},\"erros\":[]}";
  } else {
    json += "\"ok\":false,\"valores\":{},\"erros\":[\"timeout\"]}";
  }

  bool enviado = mqtt.connected() && mqtt.publish(topico.c_str(), json.c_str());
  Serial.print(enviado ? "[enviado] " : "[FALHA]   ");
  Serial.print(topico);
  Serial.print(" -> ");
  Serial.println(json);
  if (enviado) {
    digitalWrite(LED_D3, HIGH);
    desligarLedPublicacao = millis() + 150;
  }
}

// ============================================================================
// 8. SETUP E LOOP
// ============================================================================
void setup() {
  Serial.begin(115200);
  delay(1500);  // dá tempo de abrir o Monitor Serial (não depende do USB)
  Serial.println();
  Serial.println("=================================================");
  Serial.println("  OPTA — Telemetria Finder 7M.38 (Modbus RTU -> MQTT)");
  Serial.println("=================================================");

  pinMode(LED_D0, OUTPUT); pinMode(LED_D1, OUTPUT);
  pinMode(LED_D2, OUTPUT); pinMode(LED_D3, OUTPUT);

  // Modbus RTU: tempos de silêncio de 3,5 caracteres (norma Modbus), como no exemplo da Finder
  const float tempoBit = 1.0f / BAUD_MODBUS;
  const float atraso   = tempoBit * 9.6f * 3.5f * 1e6;
  RS485.setDelays(atraso, atraso);
  if (!ModbusRTUClient.begin(BAUD_MODBUS, SERIAL_8N2)) {
    Serial.println("[MODBUS] ERRO ao iniciar o RS-485.");
  }
  ModbusRTUClient.setTimeout(TIMEOUT_MODBUS_MS);

  topicoStatus = String(PREFIXO) + "/telemetria/" + GATEWAY_ID + "/status";

  mqtt.setServer(MQTT_HOST, MQTT_PORTA);
  mqtt.setBufferSize(512);
  mqtt.setKeepAlive(15);       // o broker detecta OPTA "offline" em ~20 s
  mqtt.setSocketTimeout(5);    // nunca espera mais de 5 s pelo broker
  clienteRede.setSocketTimeout(5000);

  conectarRede();
  if (redeOk) conectarMqtt();

#if USAR_WATCHDOG
  mbed::Watchdog::get_instance().start(30000);
#endif
}

void loop() {
#if USAR_WATCHDOG
  mbed::Watchdog::get_instance().kick();
#endif

  manterConexoes();
  mqtt.loop();

  if (millis() - ultimaLeitura >= INTERVALO_LEITURA) {
    ultimaLeitura = millis();
    bool todosOk = true;
    for (uint8_t i = 0; i < QTD_MEDIDORES; i++) {
      Leitura l = lerMedidor(MEDIDORES[i]);
      todosOk = todosOk && l.ok;
      publicar(MEDIDORES[i], l);
      mqtt.loop();
      delay(20);  // pequena pausa entre medidores no barramento
    }
    digitalWrite(LED_D2, todosOk ? HIGH : LOW);
  }

  digitalWrite(LED_D0, redeOk ? HIGH : LOW);
  digitalWrite(LED_D1, mqtt.connected() ? HIGH : LOW);
  if (desligarLedPublicacao && millis() > desligarLedPublicacao) {
    digitalWrite(LED_D3, LOW);
    desligarLedPublicacao = 0;
  }
}
