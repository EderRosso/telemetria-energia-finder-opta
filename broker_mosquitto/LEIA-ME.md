# Broker MQTT próprio (Mosquitto)

O broker público (broker.hivemq.com) é só para teste: qualquer pessoa que souber o
prefixo pode ler ou injetar dados. Para dados reais, use um broker com usuário e senha.

## Teste na rede local (Windows)

1. Instale o Mosquitto: https://mosquitto.org/download/ (instalador Windows 64 bits).
2. Copie `mosquitto.conf` e `acl` para `C:\mosquitto\config\` e ajuste os caminhos no `.conf`.
3. Crie as senhas (abra o terminal como administrador em `C:\Program Files\mosquitto`):
   ```
   mosquitto_passwd -c C:\mosquitto\config\passwd opta01
   mosquitto_passwd C:\mosquitto\config\passwd esp32sim
   mosquitto_passwd C:\mosquitto\config\passwd servidor
   ```
4. Rode: `mosquitto -c C:\mosquitto\config\mosquitto.conf -v`
5. Libere a porta 1883 no Firewall do Windows (rede privada).
6. Configure:
   - OPTA: `MQTT_HOST` = IP do PC; `segredos.h` com usuário `opta01` e a senha.
   - Servidor: no `.env`, `MQTT_URL=mqtt://localhost:1883`, `MQTT_USUARIO=servidor`, `MQTT_SENHA=...`

O arquivo `acl` impede, por exemplo, que o OPTA publique em nome de outro gateway
ou que alguém com a senha do OPTA leia os dados de outros clientes.

## Produção (internet)

Use a porta 8883 com TLS (certificado Let's Encrypt), `USAR_TLS 1` no OPTA e
`MQTT_URL=mqtts://seu-dominio:8883` no servidor. Alternativa sem servidor próprio:
broker gerenciado (HiveMQ Cloud ou EMQX Cloud), que já vem com TLS e usuários.
