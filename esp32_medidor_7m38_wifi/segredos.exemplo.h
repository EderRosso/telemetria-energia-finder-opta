// ============================================================================
//  segredos.exemplo.h  —  MODELO dos dados sensíveis do ESP32
//  1) Copie este arquivo para "segredos.h" (na mesma pasta do .ino)
//  2) Preencha com os dados reais
//  3) NUNCA compartilhe nem envie o "segredos.h" para o GitHub
// ============================================================================
#pragma once

// Rede Wi-Fi (o ESP32 só funciona em 2,4 GHz)
const char* WIFI_SSID  = "NOME_DA_REDE";
const char* WIFI_SENHA = "SENHA_DA_REDE";

// Usuário e senha do broker MQTT.
// Deixe "" (vazio) para o broker público de teste (broker.hivemq.com).
const char* MQTT_USUARIO = "";
const char* MQTT_SENHA   = "";
