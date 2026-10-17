/**
 * admin.js — Painel do administrador.
 */
(() => {
  const A = App;
  const { el, $, api } = A;

  const estado = {
    resumo: null,
    clientes: [],
    medidores: new Map(),      // id -> medidor (com última leitura)
    potencia: new Map(),       // id -> [{ts, potencia_w}]
    medidorGrafico: null,
    graficoGeral: null,
    graficoPotencia: null,
  };

  // ======================================================================
  // Abas
  // ======================================================================
  const carregadores = {
    geral: carregarResumo,
    faturamento: carregarFaturamento,
    clientes: carregarClientes,
    medidores: carregarMedidores,
    tarifas: carregarTarifas,
    usuarios: carregarUsuarios,
    auditoria: carregarAuditoria,
  };

  function abrirAba(nome) {
    document.querySelectorAll('.aba').forEach((b) => b.classList.toggle('ativa', b.dataset.aba === nome));
    document.querySelectorAll('main > section').forEach((s) => s.classList.toggle('oculto', s.id !== `aba-${nome}`));
    history.replaceState(null, '', `#${nome}`);
    carregadores[nome]().catch((e) => A.avisar(e.message, 'erro'));
  }
  document.querySelectorAll('.aba').forEach((b) => b.addEventListener('click', () => abrirAba(b.dataset.aba)));

  const linhaVazia = (colunas, texto) => el('tr', {}, el('td', { colspan: colunas, classe: 'vazio', texto }));
  const situacao = (ativo) => el('span', { classe: `etiqueta ${ativo ? 'ok' : ''}`, texto: ativo ? 'Ativo' : 'Inativo' });
  const statusMedidor = (m) => el('span', { classe: `etiqueta ${m.online ? 'ok' : 'erro'}` },
    [el('span', { classe: 'ponto' }), m.online ? 'Online' : 'Offline']);

  function mostrarAlertas(caixa, alertas) {
    caixa.replaceChildren(...(alertas || []).map((t) => el('div', { classe: 'mensagem-aviso', texto: t })));
  }

  // ======================================================================
  // VISÃO GERAL
  // ======================================================================
  async function carregarResumo() {
    const r = await api('/api/admin/resumo');
    estado.resumo = r;
    $('#geral-mes').textContent = `Mês de ${A.fmtMes(r.mes)} — até agora`;
    $('#kpi-kwh').replaceChildren(A.fmtNum(r.totais.kwh, 1), el('small', { texto: 'kWh' }));
    $('#kpi-valor').textContent = A.fmtReais(r.totais.valor);
    $('#kpi-tarifa').textContent = r.tarifa_vigente ? `R$ ${A.fmtNum(r.tarifa_vigente.valor_kwh, 4)}` : 'Não definida';
    $('#kpi-tarifa-desde').textContent = r.tarifa_vigente ? `por kWh, desde ${A.fmtDia(r.tarifa_vigente.vigencia_inicio)}` : 'cadastre na aba Tarifas';
    $('#kpi-online').replaceChildren(String(r.totais.online), el('small', { texto: `de ${r.totais.medidores}` }));
    $('#kpi-sem-cliente').textContent = r.totais.sem_cliente
      ? `${r.totais.sem_cliente} medidor(es) sem cliente vinculado` : 'todos vinculados a clientes';
    atualizarMqtt(r.mqtt);

    const alertas = [...r.alertas];
    if (!r.tarifa_vigente) alertas.unshift('Nenhuma tarifa vigente: o faturamento está saindo R$ 0,00. Cadastre uma tarifa.');
    mostrarAlertas($('#geral-alertas'), alertas);

    estado.medidores = new Map(r.medidores.filter((m) => m.ativo).map((m) => [m.id, m]));
    desenharTabelaAoVivo();

    if (estado.graficoGeral) estado.graficoGeral.destroy();
    estado.graficoGeral = A.graficoConsumoDiario($('#grafico-geral'), r.dias);

    if (!estado.medidorGrafico && estado.medidores.size) selecionarMedidor([...estado.medidores.keys()][0]);
    else desenharGraficoPotencia();
  }

  function desenharTabelaAoVivo() {
    const corpo = $('#tabela-aovivo');
    if (!estado.medidores.size) {
      corpo.replaceChildren(linhaVazia(9, 'Nenhum medidor ainda. Ligue o ESP32/OPTA ou rode "npm run simular".'));
      return;
    }
    corpo.replaceChildren(...[...estado.medidores.values()].map((m) => {
      const u = m.ultima || {};
      return el('tr', {
        classe: `clicavel ${estado.medidorGrafico === m.id ? 'selecionada' : ''}`,
        dados: { id: m.id },
        onclick: () => selecionarMedidor(m.id),
      }, [
        el('td', {}, [el('strong', { texto: m.nome }), el('div', { classe: 'mudo pequeno', texto: `${m.gateway_id} / ID ${m.slave_id}` })]),
        el('td', {}, m.cliente_nome || el('span', { classe: 'etiqueta alerta', texto: 'Sem cliente' })),
        el('td', {}, statusMedidor(m)),
        el('td', { classe: 'dir', texto: u.tensao_v != null ? `${A.fmtNum(u.tensao_v, 1)} V` : '—' }),
        el('td', { classe: 'dir', texto: u.corrente_a != null ? `${A.fmtNum(u.corrente_a, 2)} A` : '—' }),
        el('td', { classe: 'dir', texto: u.potencia_w != null ? `${A.fmtNum(u.potencia_w, 0)} W` : '—' }),
        el('td', { classe: 'dir esconder-celular', texto: u.energia_kwh != null ? A.fmtKwh(u.energia_kwh, 1) : '—' }),
        el('td', { classe: 'dir', texto: A.fmtKwh(m.kwh_mes, 1) }),
        el('td', { classe: 'dir', texto: A.fmtReais(m.valor_mes) }),
      ]);
    }));
  }

  function selecionarMedidor(id) {
    estado.medidorGrafico = id;
    document.querySelectorAll('#tabela-aovivo tr').forEach((tr) => tr.classList.toggle('selecionada', Number(tr.dataset.id) === id));
    desenharGraficoPotencia();
  }

  function desenharGraficoPotencia() {
    const m = estado.medidores.get(estado.medidorGrafico);
    $('#painel-potencia').classList.toggle('oculto', !m);
    if (!m) return;
    $('#titulo-potencia').textContent = `Potência ativa — ${m.nome}`;
    const pontos = estado.potencia.get(m.id) || [];
    const dados = {
      labels: pontos.map((p) => A.fmtHora(p.ts)),
      datasets: [{
        label: 'Potência (W)', data: pontos.map((p) => p.potencia_w),
        borderColor: A.CORES.teal, backgroundColor: 'rgba(45, 212, 191, 0.12)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2,
      }],
    };
    if (!estado.graficoPotencia) {
      estado.graficoPotencia = new Chart($('#grafico-potencia'), {
        type: 'line', data: dados,
        options: {
          plugins: { legend: { display: false } },
          scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: true, title: { display: true, text: 'W' } } },
        },
      });
    } else {
      estado.graficoPotencia.data = dados;
      estado.graficoPotencia.update('none');
    }
  }

  function guardarPotencia(id, leitura) {
    if (leitura.potencia_w == null) return;
    const lista = estado.potencia.get(id) || [];
    lista.push({ ts: leitura.ts, potencia_w: leitura.potencia_w });
    if (lista.length > 60) lista.shift();
    estado.potencia.set(id, lista);
  }

  function atualizarMqtt(st) {
    if (!st) return;
    const e = $('#status-mqtt');
    e.className = `etiqueta ${st.conectado ? 'ok' : 'erro'}`;
    e.title = `Broker: ${st.broker}`;
  }

  // Tempo real -------------------------------------------------------------
  let recarregarResumo;
  A.conectarTempoReal((msg) => {
    if (msg.tipo === 'estado_inicial') {
      for (const m of msg.medidores) {
        estado.potencia.set(m.medidor_id, []);
        m.historico.forEach((l) => guardarPotencia(m.medidor_id, l));
      }
      atualizarMqtt(msg.mqtt);
      desenharGraficoPotencia();
    } else if (msg.tipo === 'leitura') {
      guardarPotencia(msg.medidor_id, msg.leitura);
      const m = estado.medidores.get(msg.medidor_id);
      if (m) {
        m.ultima = msg.leitura;
        m.online = true;
        desenharTabelaAoVivo();
        if (msg.medidor_id === estado.medidorGrafico) desenharGraficoPotencia();
      }
      // Recalcula kWh/R$ do mês no máximo 1 vez por minuto
      if (!recarregarResumo && !$('#aba-geral').classList.contains('oculto')) {
        recarregarResumo = setTimeout(() => { recarregarResumo = null; carregarResumo().catch(() => {}); }, 60_000);
      }
    } else if (msg.tipo === 'mqtt') {
      atualizarMqtt(msg);
    } else if (msg.tipo === 'medidores_alterados') {
      A.avisar('Novo medidor detectado. Vincule-o a um cliente na aba Medidores.');
      if (!$('#aba-geral').classList.contains('oculto')) carregarResumo().catch(() => {});
    }
  }, (conectado) => {
    $('#status-ws').className = `etiqueta ${conectado ? 'ok' : 'erro'}`;
  });

  // ======================================================================
  // FATURAMENTO
  // ======================================================================
  $('#fat-mes').value = A.mesAtual();
  $('#fat-mes').addEventListener('change', () => carregarFaturamento().catch((e) => A.avisar(e.message, 'erro')));

  async function carregarFaturamento() {
    const mes = $('#fat-mes').value || A.mesAtual();
    $('#fat-csv').href = `/api/admin/faturamento.csv?mes=${encodeURIComponent(mes)}`;
    const f = await api(`/api/admin/faturamento?mes=${encodeURIComponent(mes)}`);
    const corpo = $('#tabela-fat');
    corpo.replaceChildren(...(f.linhas.length ? f.linhas.map((l) => el('tr', {}, [
      el('td', {}, el('strong', { texto: l.cliente })),
      el('td', { texto: l.documento || '—' }),
      el('td', { classe: 'mudo', texto: l.medidores }),
      el('td', { classe: 'dir', texto: A.fmtKwh(l.kwh, 2) }),
      el('td', { classe: 'dir', texto: A.fmtReais(l.valor) }),
    ])) : [linhaVazia(5, 'Nenhum cliente com medidor vinculado.')]));
    $('#fat-total-kwh').textContent = A.fmtKwh(f.total.kwh, 2);
    $('#fat-total-valor').textContent = A.fmtReais(f.total.valor);
    mostrarAlertas($('#fat-alertas'), f.linhas.flatMap((l) => l.alertas.map((a) => `${l.cliente}: ${a}`)));
  }

  // ======================================================================
  // CLIENTES
  // ======================================================================
  async function carregarClientes() {
    estado.clientes = await api('/api/admin/clientes');
    $('#tabela-clientes').replaceChildren(...(estado.clientes.length ? estado.clientes.map((c) => el('tr', {}, [
      el('td', {}, el('strong', { texto: c.nome })),
      el('td', { texto: c.documento || '—' }),
      el('td', { classe: 'esconder-celular', texto: c.email || '—' }),
      el('td', { classe: 'esconder-celular', texto: c.telefone || '—' }),
      el('td', { classe: 'dir', texto: c.qtd_medidores }),
      el('td', {}, situacao(c.ativo)),
      el('td', {}, el('button', { classe: 'botao-link', type: 'button', texto: 'Editar', onclick: () => formCliente(c) })),
    ])) : [linhaVazia(7, 'Nenhum cliente cadastrado.')]));
  }

  async function formCliente(c = {}) {
    const nome = el('input', { value: c.nome || '', maxlength: 120, required: true });
    const doc = el('input', { value: c.documento || '', maxlength: 30, placeholder: 'CPF ou CNPJ' });
    const email = el('input', { type: 'email', value: c.email || '', maxlength: 120 });
    const tel = el('input', { value: c.telefone || '', maxlength: 30 });
    const ativo = el('input', { type: 'checkbox', checked: c.id ? !!c.ativo : true });
    const erro = el('div', { classe: 'mensagem-erro oculto' });
    await A.dialogo({
      titulo: c.id ? 'Editar cliente' : 'Novo cliente',
      conteudo: [erro, A.campo('Nome', nome), el('div', { classe: 'linha-campos' }, [A.campo('Documento', doc), A.campo('Telefone', tel)]),
        A.campo('E-mail', email), c.id ? el('label', { classe: 'check' }, [ativo, 'Cliente ativo']) : null],
      botoes: [
        { texto: 'Cancelar', valor: false },
        {
          texto: 'Salvar', valor: true, classe: 'botao-primario',
          antes: async () => {
            const corpo = { nome: nome.value, documento: doc.value, email: email.value, telefone: tel.value, ativo: ativo.checked };
            try {
              await api(c.id ? `/api/admin/clientes/${c.id}` : '/api/admin/clientes', { metodo: c.id ? 'PUT' : 'POST', corpo });
              A.avisar('Cliente salvo.');
              carregarClientes();
              return true;
            } catch (e) { erro.textContent = e.message; erro.classList.remove('oculto'); return false; }
          },
        },
      ],
    });
  }
  $('#btn-novo-cliente').addEventListener('click', () => formCliente());

  // ======================================================================
  // MEDIDORES
  // ======================================================================
  async function carregarMedidores() {
    const [medidores, clientes] = await Promise.all([api('/api/admin/medidores'), api('/api/admin/clientes')]);
    estado.clientes = clientes;
    $('#tabela-medidores').replaceChildren(...(medidores.length ? medidores.map((m) => el('tr', {}, [
      el('td', { texto: `${m.gateway_id} / ID ${m.slave_id}` }),
      el('td', {}, el('strong', { texto: m.nome })),
      el('td', {}, m.cliente_nome || el('span', { classe: 'etiqueta alerta', texto: 'Sem cliente' })),
      el('td', {}, m.ativo ? statusMedidor(m) : el('span', { classe: 'etiqueta', texto: 'Desativado' })),
      el('td', { classe: 'esconder-celular mudo', texto: m.ultima ? A.fmtDataHora(m.ultima.ts) : '—' }),
      el('td', {}, el('button', { classe: 'botao-link', type: 'button', texto: 'Editar', onclick: () => formMedidor(m) })),
    ])) : [linhaVazia(6, 'Nenhum medidor ainda. Eles aparecem aqui ao enviar a primeira leitura.')]));
  }

  async function formMedidor(m) {
    const nome = el('input', { value: m.nome, maxlength: 120 });
    const cliente = el('select', {}, [el('option', { value: '', texto: '— Sem cliente —' }),
      ...estado.clientes.filter((c) => c.ativo || c.id === m.cliente_id)
        .map((c) => el('option', { value: c.id, texto: c.nome, selected: c.id === m.cliente_id }))]);
    const ativo = el('input', { type: 'checkbox', checked: !!m.ativo });
    const erro = el('div', { classe: 'mensagem-erro oculto' });
    await A.dialogo({
      titulo: `Medidor ${m.gateway_id} / ID ${m.slave_id}`,
      conteudo: [erro, A.campo('Nome (ex.: Sala 02, Quadro da padaria)', nome), A.campo('Cliente que paga por este medidor', cliente),
        el('label', { classe: 'check' }, [ativo, 'Medidor ativo (desativado = leituras ignoradas)'])],
      botoes: [
        { texto: 'Cancelar', valor: false },
        {
          texto: 'Salvar', valor: true, classe: 'botao-primario',
          antes: async () => {
            try {
              await api(`/api/admin/medidores/${m.id}`, { metodo: 'PUT', corpo: { nome: nome.value, cliente_id: cliente.value || null, ativo: ativo.checked } });
              A.avisar('Medidor salvo.');
              carregarMedidores();
              return true;
            } catch (e) { erro.textContent = e.message; erro.classList.remove('oculto'); return false; }
          },
        },
      ],
    });
  }

  // ======================================================================
  // TARIFAS
  // ======================================================================
  async function carregarTarifas() {
    const tarifas = await api('/api/admin/tarifas');
    const rotulo = { vigente: ['teal', 'Vigente'], futura: ['alerta', 'Futura'], encerrada: ['', 'Encerrada'] };
    $('#tabela-tarifas').replaceChildren(...(tarifas.length ? tarifas.map((t) => el('tr', {}, [
      el('td', { texto: A.fmtDia(t.vigencia_inicio) }),
      el('td', { classe: 'dir', texto: `R$ ${A.fmtNum(t.valor_kwh, 4)}` }),
      el('td', {}, el('span', { classe: `etiqueta ${rotulo[t.situacao][0]}`, texto: rotulo[t.situacao][1] })),
      el('td', { classe: 'mudo', texto: t.observacao || '' }),
      el('td', {}, t.situacao === 'futura'
        ? el('button', { classe: 'botao-link', type: 'button', texto: 'Excluir', onclick: () => excluirTarifa(t) }) : null),
    ])) : [linhaVazia(5, 'Nenhuma tarifa cadastrada.')]));
  }

  async function excluirTarifa(t) {
    if (!(await A.confirmar('Excluir tarifa', `Excluir a tarifa de R$ ${A.fmtNum(t.valor_kwh, 4)} que começaria em ${A.fmtDia(t.vigencia_inicio)}?`, 'Excluir', true))) return;
    try { await api(`/api/admin/tarifas/${t.id}`, { metodo: 'DELETE', corpo: {} }); A.avisar('Tarifa excluída.'); carregarTarifas(); }
    catch (e) { A.avisar(e.message, 'erro'); }
  }

  $('#tarifa-inicio').value = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD
  $('#form-tarifa').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const valor = $('#tarifa-valor').value;
    const inicio = $('#tarifa-inicio').value;
    const ok = await A.confirmar('Confirmar nova tarifa',
      `A partir de ${A.fmtDia(inicio)}, o kWh passa a custar R$ ${valor}. Os dias anteriores continuam com a tarifa antiga.`, 'Cadastrar');
    if (!ok) return;
    try {
      await api('/api/admin/tarifas', { metodo: 'POST', corpo: { valor_kwh: valor, vigencia_inicio: inicio, observacao: $('#tarifa-obs').value } });
      A.avisar('Tarifa cadastrada.');
      $('#tarifa-valor').value = ''; $('#tarifa-obs').value = '';
      carregarTarifas();
    } catch (e) { A.avisar(e.message, 'erro'); }
  });

  // ======================================================================
  // USUÁRIOS
  // ======================================================================
  async function carregarUsuarios() {
    const [usuarios, clientes] = await Promise.all([api('/api/admin/usuarios'), api('/api/admin/clientes')]);
    estado.clientes = clientes;
    $('#tabela-usuarios').replaceChildren(...usuarios.map((u) => {
      const bloqueado = u.bloqueado_ate && new Date(u.bloqueado_ate) > new Date();
      return el('tr', {}, [
        el('td', {}, [el('strong', { texto: u.nome }), u.cliente_nome ? el('div', { classe: 'mudo pequeno', texto: u.cliente_nome }) : null]),
        el('td', { texto: u.email }),
        el('td', {}, el('span', { classe: `etiqueta ${u.perfil === 'admin' ? 'teal' : ''}`, texto: u.perfil === 'admin' ? 'Administrador' : 'Cliente' })),
        el('td', {}, el('span', { classe: `etiqueta ${u.totp_ativo ? 'ok' : 'alerta'}`, texto: u.totp_ativo ? 'Ativo' : 'Pendente' })),
        el('td', { classe: 'esconder-celular mudo', texto: A.fmtDataHora(u.ultimo_login) }),
        el('td', {}, bloqueado ? el('span', { classe: 'etiqueta erro', texto: 'Bloqueado' }) : situacao(u.ativo)),
        el('td', {}, el('div', { classe: 'acoes-linha' }, [
          el('button', { classe: 'botao-link', type: 'button', texto: 'Nova senha', onclick: () => redefinirSenha(u) }),
          u.totp_ativo ? el('button', { classe: 'botao-link', type: 'button', texto: 'Resetar 2FA', onclick: () => resetar2fa(u) }) : null,
          el('button', { classe: 'botao-link', type: 'button', texto: u.ativo ? 'Desativar' : 'Ativar', onclick: () => alternarUsuario(u) }),
        ])),
      ]);
    }));
  }

  function mostrarSenha(titulo, email, senha) {
    return A.dialogo({
      titulo,
      conteudo: [
        el('p', { classe: 'mudo', texto: `Passe esta senha provisória para ${email}. Ela aparece só agora.` }),
        el('div', { classe: 'senha-gerada', texto: senha }),
        el('p', { classe: 'mudo pequeno', texto: 'No primeiro acesso a pessoa cria a própria senha e cadastra o 2FA no celular.' }),
      ],
      botoes: [
        { texto: 'Copiar', valor: false, antes: async () => { try { await navigator.clipboard.writeText(senha); A.avisar('Senha copiada.'); } catch { /* sem permissão */ } return false; } },
        { texto: 'Fechar', valor: true, classe: 'botao-primario' },
      ],
    });
  }

  async function formUsuario() {
    const nome = el('input', { maxlength: 120 });
    const email = el('input', { type: 'email', maxlength: 120 });
    const perfil = el('select', {}, [el('option', { value: 'cliente', texto: 'Cliente (vê só o próprio consumo)' }), el('option', { value: 'admin', texto: 'Administrador (acesso total)' })]);
    const cliente = el('select', {}, [el('option', { value: '', texto: '— Escolha —' }),
      ...estado.clientes.filter((c) => c.ativo).map((c) => el('option', { value: c.id, texto: c.nome }))]);
    const campoCliente = A.campo('Cliente', cliente);
    perfil.addEventListener('change', () => campoCliente.classList.toggle('oculto', perfil.value !== 'cliente'));
    const erro = el('div', { classe: 'mensagem-erro oculto' });
    let senha = null;
    await A.dialogo({
      titulo: 'Novo usuário',
      conteudo: [erro, A.campo('Nome', nome), A.campo('E-mail (usado no login)', email), A.campo('Perfil', perfil), campoCliente],
      botoes: [
        { texto: 'Cancelar', valor: false },
        {
          texto: 'Criar usuário', valor: true, classe: 'botao-primario',
          antes: async () => {
            try {
              const r = await api('/api/admin/usuarios', { metodo: 'POST', corpo: { nome: nome.value, email: email.value, perfil: perfil.value, cliente_id: cliente.value } });
              senha = r.senha_provisoria;
              return true;
            } catch (e) { erro.textContent = e.message; erro.classList.remove('oculto'); return false; }
          },
        },
      ],
    });
    if (senha) { await mostrarSenha('Usuário criado', email.value, senha); carregarUsuarios(); }
  }
  $('#btn-novo-usuario').addEventListener('click', () => formUsuario());

  async function redefinirSenha(u) {
    if (!(await A.confirmar('Gerar nova senha', `Gerar uma senha provisória para ${u.email}? A senha atual deixa de funcionar e as sessões abertas são encerradas.`, 'Gerar senha'))) return;
    try {
      const r = await api(`/api/admin/usuarios/${u.id}/redefinir-senha`, { metodo: 'POST', corpo: {} });
      await mostrarSenha('Nova senha provisória', u.email, r.senha_provisoria);
      carregarUsuarios();
    } catch (e) { A.avisar(e.message, 'erro'); }
  }

  async function resetar2fa(u) {
    if (!(await A.confirmar('Resetar 2FA', `Use quando ${u.nome} trocar ou perder o celular. No próximo login, será pedido um novo QR Code.`, 'Resetar', true))) return;
    try { await api(`/api/admin/usuarios/${u.id}/resetar-2fa`, { metodo: 'POST', corpo: {} }); A.avisar('2FA resetado.'); carregarUsuarios(); }
    catch (e) { A.avisar(e.message, 'erro'); }
  }

  async function alternarUsuario(u) {
    if (u.ativo && !(await A.confirmar('Desativar usuário', `${u.nome} não conseguirá mais entrar. Deseja continuar?`, 'Desativar', true))) return;
    try { await api(`/api/admin/usuarios/${u.id}`, { metodo: 'PUT', corpo: { ativo: !u.ativo } }); carregarUsuarios(); }
    catch (e) { A.avisar(e.message, 'erro'); }
  }

  // ======================================================================
  // SEGURANÇA (auditoria)
  // ======================================================================
  const NOMES_ACAO = {
    login_ok: ['ok', 'Login'], login_falhou: ['erro', 'Login falhou'], conta_bloqueada: ['erro', 'Conta bloqueada'],
    '2fa_codigo_invalido': ['alerta', 'Código 2FA inválido'], '2fa_ativado': ['teal', '2FA ativado'], '2fa_resetado': ['alerta', '2FA resetado'],
    senha_definida: ['teal', 'Senha definida'], senha_alterada: ['teal', 'Senha alterada'], senha_redefinida: ['alerta', 'Senha redefinida'],
  };
  async function carregarAuditoria() {
    const lista = await api('/api/admin/auditoria?limite=300');
    $('#tabela-auditoria').replaceChildren(...(lista.length ? lista.map((a) => {
      const [cor, rotulo] = NOMES_ACAO[a.acao] || ['', a.acao.replace(/_/g, ' ')];
      return el('tr', {}, [
        el('td', { classe: 'num', texto: A.fmtDataHora(a.ts) }),
        el('td', { texto: a.email || '—' }),
        el('td', {}, el('span', { classe: `etiqueta ${cor}`, texto: rotulo })),
        el('td', { classe: 'mudo', texto: a.detalhe || '' }),
        el('td', { classe: 'esconder-celular mudo', texto: a.ip || '' }),
      ]);
    }) : [linhaVazia(5, 'Nenhum evento registrado.')]));
  }
  $('#btn-atualizar-auditoria').addEventListener('click', () => carregarAuditoria());

  // ======================================================================
  // Início
  // ======================================================================
  $('#btn-sair').addEventListener('click', A.sair);
  $('#btn-senha').addEventListener('click', A.trocarSenha);
  api('/api/auth/estado').then((r) => { $('#usuario-nome').textContent = r.usuario.nome; }).catch(() => {});
  const abaInicial = location.hash.slice(1);
  abrirAba(carregadores[abaInicial] ? abaInicial : 'geral');
})();
