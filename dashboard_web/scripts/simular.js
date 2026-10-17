/**
 * simular.js — Simula um ou mais medidores 7M.38 enviando leituras pelo MQTT,
 * no MESMO formato do ESP32/OPTA. Serve para testar o site sem a placa.
 * (Substitui o antigo botão "Simular leitura", que ficava aberto para qualquer um.)
 *
 * Uso:  npm run simular                     -> 1 medidor (ID 33), a cada 5 s
 *       npm run simular -- --medidores 3    -> IDs 33, 34 e 35
 *       npm run simular -- --intervalo 2 --gateway opta02
 */
const mqtt = require('mqtt');
const config = require('../src/config');

const arg = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
};
const QTD = Number(arg('medidores', 1));
const INTERVALO_S = Number(arg('intervalo', 5));
const GATEWAY = arg('gateway', 'opta01');
const PRIMEIRO_ID = Number(arg('id', 33));

const topicoStatus = `${config.PREFIXO}/telemetria/${GATEWAY}/status`;
const medidores = Array.from({ length: QTD }, (_, i) => ({
  slave_id: PRIMEIRO_ID + i,
  energiaWh: 1_500_000 + i * 250_000, // acumulador em double (sem perda de precisão)
  cargaBase: 2 + i * 1.5,
}));

const cliente = mqtt.connect(config.MQTT_URL, {
  username: config.MQTT_USUARIO, password: config.MQTT_SENHA,
  will: { topic: topicoStatus, payload: 'offline', qos: 1, retain: true },
});

cliente.on('connect', () => {
  console.log(`[SIMULADOR] Conectado a ${config.MQTT_URL}. Gateway ${GATEWAY}, ${QTD} medidor(es).`);
  cliente.publish(topicoStatus, 'online', { qos: 1, retain: true });
  setInterval(enviar, INTERVALO_S * 1000);
  enviar();
});
cliente.on('error', (e) => console.error('[SIMULADOR] Erro MQTT:', e.message));

const aleatorio = (min, max) => min + Math.random() * (max - min);

function enviar() {
  for (const m of medidores) {
    const tensao = aleatorio(124, 130);
    const corrente = Math.max(0, m.cargaBase + aleatorio(-1, 3));
    const fp = aleatorio(0.92, 0.98);
    const potencia = tensao * corrente * fp;
    m.energiaWh += potencia * INTERVALO_S / 3600;
    const carga = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      slave_id: m.slave_id, modelo: 'FINDER_7M38', ok: true,
      valores: {
        tensao_v: +tensao.toFixed(2), corrente_a: +corrente.toFixed(3), potencia_w: +potencia.toFixed(1),
        fp: +fp.toFixed(3), frequencia_hz: +aleatorio(59.95, 60.05).toFixed(2),
        energia_kwh: +(m.energiaWh / 1000).toFixed(3),
      },
      erros: [],
    };
    const topico = `${config.PREFIXO}/telemetria/${GATEWAY}/medidor/${m.slave_id}`;
    cliente.publish(topico, JSON.stringify(carga), { qos: 1 });
    console.log(`[enviado] ID ${m.slave_id}: ${carga.valores.potencia_w} W | ${carga.valores.energia_kwh} kWh`);
  }
}
