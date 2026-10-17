#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
===============================================================================
PROJETO: Telemetria de Energia — Receptor MQTT no PC
ARQUIVO: receptor_mqtt.py
OBJETIVO:
Assinar os tópicos MQTT de telemetria enviados pelo ESP32 (simulador Finder 7M.38 + OPTA),
exibir o status do gateway (ONLINE/OFFLINE) e imprimir as leituras elétricas formatadas.

REQUISITOS:
- Python 3.8+
- paho-mqtt==2.1.0 (instalar com: pip install -r requirements.txt)

COMO EXECUTAR:
  python receptor_mqtt.py --prefixo meu_projeto_energia_123
===============================================================================
"""

import argparse
import json
import sys
import time
from datetime import datetime
import paho.mqtt.client as mqtt


def formatar_hora_exibicao(ts_iso: str | None) -> str:
    """
    Retorna a hora no formato HH:MM:SS.
    Se o timestamp ISO-8601 for fornecido (ex: '2026-10-16T22:50:00Z'), tenta
    utilizar o horário convertido ou cai graciosamente para a hora local do PC.
    """
    if ts_iso and isinstance(ts_iso, str):
        try:
            # Substitui 'Z' por '+00:00' para compatibilidade com fromisoformat no Python
            limpo = ts_iso.replace("Z", "+00:00")
            dt_utc = datetime.fromisoformat(limpo)
            # Converte de UTC para o fuso horário local do computador
            dt_local = dt_utc.astimezone()
            return dt_local.strftime("%H:%M:%S")
        except Exception:
            pass
    # Se ts for None ou falhar a conversão, usa a hora do relógio local no recebimento
    return datetime.now().strftime("%H:%M:%S")


def parse_argumentos():
    """Configura e processa os argumentos de linha de comando."""
    parser = argparse.ArgumentParser(
        description="Receptor MQTT para telemetria de medidor de energia Finder 7M.38 (ESP32/OPTA)."
    )
    parser.add_argument(
        "--host",
        type=str,
        default="broker.hivemq.com",
        help="Endereço do broker MQTT (padrão: broker.hivemq.com)",
    )
    parser.add_argument(
        "--porta",
        type=int,
        default=1883,
        help="Porta TCP do broker MQTT (padrão: 1883)",
    )
    parser.add_argument(
        "--prefixo",
        type=str,
        default="meu_projeto_energia_123",
        help="Prefixo único dos tópicos (DEVE ser idêntico ao configurado no ESP32)",
    )
    return parser.parse_args()


# =============================================================================
# CALLBACKS DO PAHO-MQTT (API Versão 2)
# =============================================================================

def on_connect(client, userdata, flags, reason_code, properties):
    """Executado quando a conexão com o broker for estabelecida."""
    if reason_code.is_failure:
        print(f"[FALHA NA CONEXAO] Não foi possível conectar ao broker. Motivo: {reason_code}", flush=True)
        return

    topico_inscricao = f"{userdata['prefixo']}/telemetria/#"
    print(f"[CONECTADO] Conectado com sucesso ao broker '{userdata['host']}:{userdata['porta']}'.", flush=True)
    print(f"[INSCRITO] Assinando tópico: {topico_inscricao}", flush=True)
    print("--------------------------------------------------------------------------------", flush=True)
    print("Aguardando mensagens... (Pressione Ctrl+C para encerrar a qualquer momento)", flush=True)
    print("--------------------------------------------------------------------------------", flush=True)

    # Assina todos os tópicos abaixo de {prefixo}/telemetria/
    client.subscribe(topico_inscricao, qos=1)


def on_disconnect(client, userdata, flags, reason_code, properties):
    """Executado em caso de perda de conexão com o broker."""
    if reason_code != 0:
        print(f"[DESCONECTADO] Conexão com o broker perdida inesperadamente (código: {reason_code}). Tentando reconectar...", flush=True)


def on_message(client, userdata, message):
    """Executado a cada mensagem recebida."""
    topico = message.topic
    try:
        payload_texto = message.payload.decode("utf-8").strip()
    except UnicodeDecodeError:
        print(f"[AVISO] Payload com codificação não-UTF8 recebido no tópico '{topico}'. Ignorado.", flush=True)
        return

    # 1. Tratamento de mensagens de STATUS do gateway (/status)
    if topico.endswith("/status"):
        status_valor = payload_texto.upper()
        print(f"STATUS do gateway: {status_valor}", flush=True)
        return

    # 2. Tratamento de mensagens de LEITURA do medidor (/medidor/<id>)
    if "/medidor/" in topico:
        # Decodifica o JSON
        try:
            dados = json.loads(payload_texto)
        except json.JSONDecodeError as err:
            print(f"[ERRO] JSON inválido recebido no tópico '{topico}': {err}", flush=True)
            print(f"       Conteúdo bruto: {payload_texto}", flush=True)
            return

        # Verifica se o JSON é um dicionário
        if not isinstance(dados, dict):
            print(f"[ERRO] Formato inesperado de payload (não é objeto JSON): {payload_texto}", flush=True)
            return

        # Verifica o campo "ok"
        status_ok = dados.get("ok", False)
        if not status_ok:
            erros = dados.get("erros", [])
            print(f"[ALERTA] Medidor reportou falha (ok=false). Tópico: {topico} | Erros: {erros}", flush=True)
            return

        # Extrai os dados do medidor
        slave_id = dados.get("slave_id", 33)
        ts_iso = dados.get("ts")
        hora = formatar_hora_exibicao(ts_iso)

        valores = dados.get("valores", {})
        tensao = float(valores.get("tensao_v", 0.0))
        corrente = float(valores.get("corrente_a", 0.0))
        potencia = float(valores.get("potencia_w", 0.0))
        fp = float(valores.get("fp", 0.0))
        frequencia = float(valores.get("frequencia_hz", 0.0))
        energia = float(valores.get("energia_kwh", 0.0))

        # Imprime a linha formatada conforme especificado
        print(
            f"{hora} [ID {slave_id}] "
            f"Tensao: {tensao:.1f} V | "
            f"Corrente: {corrente:.2f} A | "
            f"Potencia: {potencia:.0f} W | "
            f"FP: {fp:.2f} | "
            f"Frequencia: {frequencia:.2f} Hz | "
            f"Energia: {energia:.3f} kWh",
            flush=True
        )


# =============================================================================
# EXECUÇÃO PRINCIPAL
# =============================================================================

def main():
    args = parse_argumentos()

    print("================================================================================")
    print("      RECEPTOR DE TELEMETRIA MQTT — MEDIDOR FINDER 7M.38 (SIMULADO)")
    print("================================================================================")
    print(f"Broker:  {args.host}:{args.porta}")
    print(f"Prefixo: {args.prefixo}")
    print("================================================================================")

    # Dados passados para os callbacks através do userdata
    userdata = {
        "host": args.host,
        "porta": args.porta,
        "prefixo": args.prefixo,
    }

    # Inicializa o cliente com a versão 2 da API de Callbacks do Paho MQTT
    client_id = f"receptor-pc-{int(time.time())}"
    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=client_id,
        userdata=userdata,
    )

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message

    print(f"[INICIANDO] Conectando ao broker '{args.host}:{args.porta}'...")
    try:
        client.connect(args.host, args.porta, keepalive=60)
    except Exception as e:
        print(f"[ERRO CRITICO] Não foi possível conectar ao broker '{args.host}:{args.porta}': {e}")
        print("DICA: Verifique sua conexão com a internet ou se a porta 1883 está liberada na rede.")
        sys.exit(1)

    # Inicia a thread de rede do Paho MQTT
    client.loop_start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\n[ENCERRANDO] Interrupção solicitada pelo usuário (Ctrl+C).")
    finally:
        client.loop_stop()
        client.disconnect()
        print("[FINALIZADO] Cliente desconectado do broker. Até logo!")


if __name__ == "__main__":
    main()
