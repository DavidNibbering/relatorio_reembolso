import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, collection, getDocs, addDoc, doc, updateDoc, deleteDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { HTML_GLOSSARIO_E_NORMAS, HTML_CONDICOES_GERAIS_BRADESCO } from "./normas.js";

const firebaseConfig = {
  apiKey: "AIzaSyC4XH3VcBpGiJfRVAN4YErIG0dGR2d1s6E",
  authDomain: "reembolso-ab603.firebaseapp.com",
  projectId: "reembolso-ab603",
  storageBucket: "reembolso-ab603.firebasestorage.app",
  messagingSenderId: "539577875283",
  appId: "1:539577875283:web:87815522ca00c6bdccffa6"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const UFS_BRASIL = [
  "AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG",
  "PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"
];

document.getElementById("cadUf").innerHTML = UFS_BRASIL
  .map(uf => `<option value="${uf}" ${uf === "PE" ? "selected" : ""}>${uf}</option>`)
  .join("");

const REGRAS_TUSS_CONHECIDAS = {
  "30713137": { maxAux: 0, motivo: "Punção articular (30713137) não contempla 1º nem 2º auxiliar na tabela TUSS." },
  "30713153": { maxAux: 1, motivo: "Artroscopia diagnóstica (30713153) não contempla 2º auxiliar na tabela TUSS." }
};

let todosProcedimentos = [];
let procedimentosDoPlano = [];
let procedimentosSelecionados = [];
let uidPrincipalManual = null;
let percentuaisCustomizados = {};
let ultimoCalculoCache = null;

let todosProfissionais = [];
let equipeSelecionada = {
  cirurgiao: null,
  aux1: null,
  aux2: null,
  instrumentador: null
};
let tipoModalAtual = "doutor";
let slotOrigemModal = "cirurgiao";

// Estado dos Relatórios / Rascunhos Salvos
let rascunhosSalvos = [];
let rascunhoAtualId = null;

function escaparHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function lerDecimal(valor) {
  if (typeof valor === "number") return isNaN(valor) ? 0 : valor;
  if (!valor) return 0;
  const limpo = String(valor).trim().replace(/\s+/g, "").replace(",", ".");
  const num = parseFloat(limpo);
  return isNaN(num) ? 0 : num;
}

function arredondar2(valor) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function formatarMoeda(valor) {
  return valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatarNumero(valor, minCasas = 2, maxCasas = 6) {
  return Number(valor).toLocaleString("pt-BR", {
    minimumFractionDigits: minCasas,
    maximumFractionDigits: maxCasas
  });
}

function formatarCpf(v) {
  const d = String(v || "").replace(/\D/g, "").slice(0, 11);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0,3)}.${d.slice(3)}`;
  if (d.length <= 9) return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6)}`;
  return `${d.slice(0,3)}.${d.slice(3,6)}.${d.slice(6,9)}-${d.slice(9)}`;
}

document.getElementById("cadCpf").addEventListener("input", (e) => {
  e.target.value = formatarCpf(e.target.value);
});

// ==================== CÁLCULO DE PORCENTAGEM E GRADIENTE (0% VERMELHO -> 100% VERDE) ====================

function corGradientePorcentagem(pct) {
  const clamped = Math.max(0, Math.min(100, pct));
  const hue = Math.round((clamped / 100) * 138);
  const lightness = clamped > 40 && clamped < 70 ? 40 : 42;
  return `hsl(${hue}, 82%, ${lightness}%)`;
}

function calcularProgressoDados(dados) {
  const procs = Array.isArray(dados.procedimentos) ? dados.procedimentos : [];
  const maxAuxProcedimentos = procs.reduce((acc, p) => Math.max(acc, Number(p.quant_aux) || 0), 0);

  const cirurgiao = dados.cirurgiao || null;
  const aux1 = dados.aux1 || null;
  const aux2 = dados.aux2 || null;
  const inst = dados.instrumentador || null;

  const exigeAux1 = maxAuxProcedimentos >= 1 || Boolean(aux1 && (aux1.nome || aux1.registro || aux1.cpf));
  const exigeAux2 = maxAuxProcedimentos >= 2 || Boolean(aux2 && (aux2.nome || aux2.registro || aux2.cpf));
  const exigeInst = procs.length > 0 || Boolean(inst && (inst.nome || inst.cpf));

  const criterios = [
    { ok: Boolean(dados.plano && dados.plano.trim()), label: "Plano" },
    { ok: Boolean(dados.paciente && dados.paciente.trim()), label: "Paciente" },
    { ok: Boolean(dados.cartao && dados.cartao.trim()), label: "Cartão" },
    { ok: lerDecimal(dados.valorUs) > 0 && lerDecimal(dados.multiplo) > 0, label: "Valor US" },
    { ok: procs.length > 0, label: "Procedimentos" },
    { ok: Boolean(cirurgiao?.nome && cirurgiao.nome.trim()), label: "Cirurgião (Nome)" },
    { ok: Boolean(cirurgiao?.registro && cirurgiao.registro.trim()), label: "Cirurgião (CRO)" },
    { ok: Boolean(cirurgiao?.cpf && cirurgiao.cpf.trim()), label: "Cirurgião (CPF)" }
  ];

  if (exigeAux1) {
    criterios.push(
      { ok: Boolean(aux1?.nome && aux1.nome.trim()), label: "1º Auxiliar (Nome)" },
      { ok: Boolean(aux1?.registro && aux1.registro.trim()), label: "1º Auxiliar (CRO)" },
      { ok: Boolean(aux1?.cpf && aux1.cpf.trim()), label: "1º Auxiliar (CPF)" }
    );
  }

  if (exigeAux2) {
    criterios.push(
      { ok: Boolean(aux2?.nome && aux2.nome.trim()), label: "2º Auxiliar (Nome)" },
      { ok: Boolean(aux2?.registro && aux2.registro.trim()), label: "2º Auxiliar (CRO)" },
      { ok: Boolean(aux2?.cpf && aux2.cpf.trim()), label: "2º Auxiliar (CPF)" }
    );
  }

  if (exigeInst) {
    criterios.push(
      { ok: Boolean(inst?.nome && inst.nome.trim()), label: "Instrumentador (Nome)" },
      { ok: Boolean(inst?.cpf && inst.cpf.trim()), label: "Instrumentador (CPF)" }
    );
  }

  const concluidos = criterios.filter(c => c.ok).length;
  const porcentagem = Math.round((concluidos / criterios.length) * 100);
  const faltando = criterios.filter(c => !c.ok).map(c => c.label);

  return { porcentagem, faltando };
}

function atualizarBarraProgressoAtual() {
  const estadoAtual = {
    plano: document.getElementById("planoSelect").value,
    paciente: document.getElementById("pacienteInput").value,
    cartao: document.getElementById("cartaoInput").value,
    valorUs: document.getElementById("valorUsInput").value,
    multiplo: document.getElementById("multiploInput").value,
    cirurgiao: equipeSelecionada.cirurgiao,
    aux1: equipeSelecionada.aux1,
    aux2: equipeSelecionada.aux2,
    instrumentador: equipeSelecionada.instrumentador,
    procedimentos: procedimentosSelecionados
  };

  const { porcentagem, faltando } = calcularProgressoDados(estadoAtual);
  const cor = corGradientePorcentagem(porcentagem);

  const badgeEl = document.getElementById("progressoPctTexto");
  const fillEl = document.getElementById("progressoBarraFill");
  const faltandoEl = document.getElementById("progressoFaltandoTexto");

  badgeEl.innerText = `${porcentagem}%`;
  badgeEl.style.backgroundColor = cor;
  fillEl.style.width = `${porcentagem}%`;
  fillEl.style.backgroundColor = cor;

  if (faltando.length === 0) {
    faltandoEl.innerHTML = `<span style="color: #166534; font-weight: 600;">✓ Todos os dados obrigatórios e da equipe estão preenchidos! Pronto para gerar o PDF.</span>`;
  } else {
    faltandoEl.innerText = `Faltam: ${faltando.join(", ")}`;
  }

  return { porcentagem, faltando };
}

// ==================== PERSISTÊNCIA DE RASCUNHOS NO FIREBASE ====================

async function buscarColecaoRest(nomeColecao) {
  const url = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents/${nomeColecao}?pageSize=500&key=${firebaseConfig.apiKey}`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (!resp.ok) {
    throw new Error(json?.error?.message || `HTTP ${resp.status}`);
  }
  const lista = [];
  (json.documents || []).forEach((docItem) => {
    const f = docItem.fields || {};
    const obj = { id: docItem.name.split("/").pop() };
    Object.keys(f).forEach((k) => {
      const c = f[k];
      obj[k] = c?.stringValue ?? (c?.doubleValue !== undefined ? Number(c.doubleValue) : (c?.integerValue !== undefined ? Number(c.integerValue) : ""));
    });
    lista.push(obj);
  });
  return lista;
}

async function carregarColecaoComFallback(nomeColecao) {
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_SDK")), 6000));
    const snap = await Promise.race([getDocs(collection(db, nomeColecao)), timeout]);
    const lista = [];
    snap.forEach((docSnap) => {
      lista.push({ id: docSnap.id, ...docSnap.data() });
    });
    return lista;
  } catch (err) {
    console.warn(`Fallback REST para ${nomeColecao}:`, err.message);
    return await buscarColecaoRest(nomeColecao);
  }
}

async function carregarRascunhosSalvos() {
  try {
    const regs = await carregarColecaoComFallback("reembolsos");
    rascunhosSalvos = regs
      .map(r => {
        let payload = {};
        try {
          payload = r.dados_json ? JSON.parse(r.dados_json) : {};
        } catch (_) {
          payload = {};
        }
        return {
          id: r.id,
          paciente: String(r.paciente || payload.paciente || "Paciente sem nome"),
          plano: String(r.plano || payload.plano || "Plano não selecionado"),
          cartao: String(r.cartao || payload.cartao || ""),
          observacoes: String(r.observacoes ?? payload.observacoes ?? ""),
          porcentagem: Number(r.porcentagem ?? 0),
          total_geral: Number(r.total_geral ?? 0),
          atualizado_em: String(r.atualizado_em || ""),
          payload
        };
      })
      .sort((a, b) => b.atualizado_em.localeCompare(a.atualizado_em));

    renderizarListaRascunhos();
  } catch (e) {
    console.error("Erro ao carregar relatórios salvos:", e);
    document.getElementById("listaRascunhosContainer").innerHTML =
      `<div style="font-size: 0.85rem; color: #dc2626;">Não foi possível carregar os relatórios salvos: ${escaparHtml(e.message)}</div>`;
  }
}

function renderizarListaRascunhos() {
  const container = document.getElementById("listaRascunhosContainer");
  const badge = document.getElementById("badgeRascunhos");
  const termo = (document.getElementById("buscaRascunhoInput").value || "").toLowerCase().trim();

  badge.innerText = rascunhosSalvos.length;

  const filtrados = rascunhosSalvos.filter(r =>
    r.paciente.toLowerCase().includes(termo) ||
    r.plano.toLowerCase().includes(termo) ||
    r.cartao.toLowerCase().includes(termo) ||
    r.observacoes.toLowerCase().includes(termo)
  );

  if (filtrados.length === 0) {
    container.innerHTML = `<div style="font-size: 0.86rem; color: #64748b;">Nenhum relatório salvo encontrado. Preencha os dados abaixo e clique em <strong>Salvar Rascunho</strong>.</div>`;
    return;
  }

  container.innerHTML = `<div class="rascunhos-grid">` + filtrados.map(r => {
    const prog = calcularProgressoDados({
      plano: r.plano !== "Plano não selecionado" ? r.plano : "",
      paciente: r.paciente !== "Paciente sem nome" ? r.paciente : "",
      cartao: r.cartao,
      valorUs: r.payload?.valorUs,
      multiplo: r.payload?.multiplo,
      cirurgiao: r.payload?.equipe?.cirurgiao,
      aux1: r.payload?.equipe?.aux1,
      aux2: r.payload?.equipe?.aux2,
      instrumentador: r.payload?.equipe?.instrumentador,
      procedimentos: r.payload?.procedimentos || []
    });

    const cor = corGradientePorcentagem(prog.porcentagem);
    const emEdicao = r.id === rascunhoAtualId;
    const dataFormatada = r.atualizado_em
      ? new Date(r.atualizado_em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "";
    const obsTexto = (r.observacoes || "").trim();

    return `
      <div class="rascunho-card ${emEdicao ? "em-edicao" : ""}">
        <div>
          <div class="rascunho-header">
            <div>
              <div class="rascunho-nome">${escaparHtml(r.paciente)}</div>
              <div class="rascunho-meta">
                <strong>${escaparHtml(r.plano)}</strong>${r.cartao ? ` &bull; Cartão: ${escaparHtml(r.cartao)}` : ""}
              </div>
            </div>
            <span class="progresso-pct-badge" style="background-color: ${cor}; font-size: 0.78rem;">${prog.porcentagem}%</span>
          </div>

          <div class="progresso-track" style="height: 7px; margin-top: 9px;">
            <div class="progresso-fill" style="width: ${prog.porcentagem}%; background-color: ${cor};"></div>
          </div>

          <div class="progresso-faltando" style="margin-top: 6px;">
            ${prog.faltando.length === 0
              ? `<span style="color: #166534; font-weight: 600;">✓ Completo</span>`
              : `Faltam: ${escaparHtml(prog.faltando.join(", "))}`}
            ${r.total_geral > 0 ? ` &bull; Total: <strong>${formatarMoeda(r.total_geral)}</strong>` : ""}
          </div>

          ${obsTexto ? `<div class="rascunho-obs-preview" title="${escaparHtml(obsTexto)}"><strong>Obs:</strong> ${escaparHtml(obsTexto)}</div>` : ""}
        </div>

        <div class="rascunho-footer">
          <span style="font-size: 0.72rem; color: #64748b;">${dataFormatada}</span>
          <button type="button" class="btn-abrir-rascunho" onclick="carregarRascunhoNoFormulario('${r.id}')">
            ${emEdicao ? "Em edição" : "Continuar"}
          </button>
          <button type="button" class="btn-del-rascunho" title="Excluir rascunho" onclick="excluirRascunho('${r.id}')">✕</button>
        </div>
      </div>
    `;
  }).join("") + `</div>`;
}

document.getElementById("btnSalvarRascunho").addEventListener("click", async () => {
  const btn = document.getElementById("btnSalvarRascunho");
  const textoBtn = document.getElementById("textoBtnSalvarRascunho");
  const statusEl = document.getElementById("statusRascunhoSalvo");

  const plano = document.getElementById("planoSelect").value;
  const paciente = document.getElementById("pacienteInput").value.trim();
  const cartao = document.getElementById("cartaoInput").value.trim();
  const multiplo = document.getElementById("multiploInput").value.trim();
  const valorUs = document.getElementById("valorUsInput").value.trim();
  const observacoes = document.getElementById("observacoesInput").value.trim();

  if (!paciente && !plano && procedimentosSelecionados.length === 0 && !observacoes) {
    alert("Preencha pelo menos o nome do paciente, uma observação ou selecione um plano antes de salvar.");
    return;
  }

  const { porcentagem } = atualizarBarraProgressoAtual();

  const payloadCompleto = {
    plano,
    paciente,
    cartao,
    multiplo,
    valorUs,
    observacoes,
    equipe: equipeSelecionada,
    procedimentos: procedimentosSelecionados,
    uidPrincipalManual,
    percentuaisCustomizados
  };

  const registroFirestore = {
    paciente: paciente || "Paciente sem nome",
    plano: plano || "Plano não selecionado",
    cartao,
    observacoes,
    porcentagem,
    total_geral: ultimoCalculoCache ? ultimoCalculoCache.totalGeral : 0,
    atualizado_em: new Date().toISOString(),
    dados_json: JSON.stringify(payloadCompleto)
  };

  btn.disabled = true;
  textoBtn.innerText = "Salvando...";
  statusEl.innerText = "";

  try {
    if (rascunhoAtualId) {
      await updateDoc(doc(db, "reembolsos", rascunhoAtualId), registroFirestore);
      statusEl.innerText = `✓ Relatório de "${registroFirestore.paciente}" atualizado (${porcentagem}% preenchido).`;
    } else {
      const docRef = await addDoc(collection(db, "reembolsos"), registroFirestore);
      rascunhoAtualId = docRef.id;
      document.getElementById("tagEditandoRascunho").classList.remove("hidden");
      textoBtn.innerText = "Atualizar Rascunho";
      statusEl.innerText = `✓ Novo rascunho salvo para "${registroFirestore.paciente}" (${porcentagem}% preenchido).`;
    }

    await carregarRascunhosSalvos();
  } catch (e) {
    console.error("Erro ao salvar rascunho:", e);
    alert("Erro ao salvar relatório no Firebase: " + e.message);
  } finally {
    btn.disabled = false;
    textoBtn.innerText = rascunhoAtualId ? "Atualizar Rascunho" : "Salvar Rascunho";
  }
});

window.carregarRascunhoNoFormulario = (id) => {
  const item = rascunhosSalvos.find(r => r.id === id);
  if (!item) return;

  const p = item.payload || {};
  rascunhoAtualId = item.id;

  document.getElementById("tagEditandoRascunho").classList.remove("hidden");
  document.getElementById("textoBtnSalvarRascunho").innerText = "Atualizar Rascunho";
  document.getElementById("statusRascunhoSalvo").innerText = `Editando relatório salvo de "${item.paciente}".`;

  const selectPlano = document.getElementById("planoSelect");
  selectPlano.value = p.plano || "";

  if (selectPlano.value) {
    procedimentosDoPlano = todosProcedimentos
      .filter(proc => proc.plano === selectPlano.value)
      .sort((a, b) => a.nome.localeCompare(b.nome));
    document.getElementById("cardDisponiveis").classList.remove("hidden");
    renderizarDisponiveis();
  } else {
    procedimentosDoPlano = [];
    document.getElementById("cardDisponiveis").classList.add("hidden");
  }

  document.getElementById("pacienteInput").value = p.paciente || "";
  document.getElementById("cartaoInput").value = p.cartao || "";
  document.getElementById("multiploInput").value = p.multiplo || "1";
  document.getElementById("valorUsInput").value = p.valorUs || "";
  document.getElementById("observacoesInput").value = p.observacoes ?? item.observacoes ?? "";

  equipeSelecionada = {
    cirurgiao: p.equipe?.cirurgiao || null,
    aux1: p.equipe?.aux1 || null,
    aux2: p.equipe?.aux2 || null,
    instrumentador: p.equipe?.instrumentador || null
  };

  ["cirurgiao", "aux1", "aux2", "instrumentador"].forEach((slot) => {
    const pessoa = equipeSelecionada[slot];
    document.getElementById(`busca_${slot}`).value = pessoa ? pessoa.nome : "";
    renderizarBoxEdicaoSlot(slot);
  });

  procedimentosSelecionados = Array.isArray(p.procedimentos) ? p.procedimentos : [];
  uidPrincipalManual = p.uidPrincipalManual ?? null;
  percentuaisCustomizados = p.percentuaisCustomizados || {};

  atualizarTudo();
  renderizarListaRascunhos();
  window.scrollTo({ top: document.getElementById("planoSelect").offsetTop - 90, behavior: "smooth" });
};

window.excluirRascunho = async (id) => {
  const item = rascunhosSalvos.find(r => r.id === id);
  if (!item) return;
  if (!confirm(`Deseja excluir o relatório salvo de "${item.paciente}"?`)) return;

  try {
    await deleteDoc(doc(db, "reembolsos", id));
    if (rascunhoAtualId === id) {
      limparFormularioParaNovo();
    }
    await carregarRascunhosSalvos();
  } catch (e) {
    console.error("Erro ao excluir rascunho:", e);
    alert("Erro ao excluir: " + e.message);
  }
};

function limparFormularioParaNovo() {
  rascunhoAtualId = null;
  document.getElementById("tagEditandoRascunho").classList.add("hidden");
  document.getElementById("textoBtnSalvarRascunho").innerText = "Salvar Rascunho";
  document.getElementById("statusRascunhoSalvo").innerText = "";

  document.getElementById("planoSelect").value = "";
  document.getElementById("pacienteInput").value = "";
  document.getElementById("cartaoInput").value = "";
  document.getElementById("multiploInput").value = "1";
  document.getElementById("valorUsInput").value = "";
  document.getElementById("observacoesInput").value = "";

  equipeSelecionada = { cirurgiao: null, aux1: null, aux2: null, instrumentador: null };
  ["cirurgiao", "aux1", "aux2", "instrumentador"].forEach((slot) => {
    document.getElementById(`busca_${slot}`).value = "";
    document.getElementById(`edit_${slot}`).innerHTML = "";
  });

  procedimentosDoPlano = [];
  procedimentosSelecionados = [];
  uidPrincipalManual = null;
  percentuaisCustomizados = {};
  document.getElementById("cardDisponiveis").classList.add("hidden");

  atualizarTudo();
  renderizarListaRascunhos();
}

document.getElementById("btnNovoRelatorio").addEventListener("click", limparFormularioParaNovo);
document.getElementById("btnAtualizarRascunhos").addEventListener("click", carregarRascunhosSalvos);
document.getElementById("buscaRascunhoInput").addEventListener("input", renderizarListaRascunhos);

// ==================== CARREGAMENTO INICIAL ====================

async function carregarProfissionais() {
  try {
    const regs = await carregarColecaoComFallback("profissionais");
    todosProfissionais = regs
      .map(p => ({
        id: p.id,
        tipo: p.tipo === "instrumentador" ? "instrumentador" : "doutor",
        nome: String(p.nome || ""),
        registro: String(p.registro || p.cro || p.coren || ""),
        uf: String(p.uf || ""),
        cpf: String(p.cpf || "")
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome));

    document.getElementById("badgeProfissionais").innerText = `${todosProfissionais.length} cadastrado(s)`;
  } catch (e) {
    console.error("Erro ao carregar profissionais:", e);
  }
}

async function inicializarDados() {
  const select = document.getElementById("planoSelect");
  const status = document.getElementById("statusMsg");

  select.innerHTML = `<option value="">Carregando planos...</option>`;
  status.className = "status";
  status.innerText = "Buscando planos, profissionais e rascunhos no Firebase...";

  try {
    const [registros] = await Promise.all([
      carregarColecaoComFallback("procedimentos"),
      carregarProfissionais(),
      carregarRascunhosSalvos()
    ]);

    const planosUnicos = new Set();
    todosProcedimentos = [];

    registros.forEach((dados) => {
      if (dados && dados.plano) {
        const nomePlano = String(dados.plano).trim();
        planosUnicos.add(nomePlano);
        const auxRaw = Number(dados.quant_aux);
        const auxNormalizado = isNaN(auxRaw) ? 0 : Math.min(2, Math.max(0, Math.round(auxRaw)));
        todosProcedimentos.push({
          id: dados.id,
          plano: nomePlano,
          codigo: String(dados.codigo || ""),
          nome: String(dados.nome || ""),
          qtd_us: lerDecimal(dados.qtd_us),
          quant_aux: auxNormalizado,
          quant_aux_original: auxNormalizado
        });
      }
    });

    const listaPlanos = Array.from(planosUnicos).sort();

    if (listaPlanos.length === 0) {
      select.innerHTML = `<option value="">Nenhum plano cadastrado no Firebase</option>`;
      status.innerText = `Conexão OK, mas nenhum procedimento foi encontrado na coleção "procedimentos".`;
      return;
    }

    select.innerHTML = `<option value="">Selecione um plano de saúde...</option>` +
      listaPlanos.map(plano => `<option value="${plano}">${plano}</option>`).join("");
    status.innerText = `${listaPlanos.length} plano(s) carregado(s) (${todosProcedimentos.length} procedimentos).`;

  } catch (e) {
    console.error("Erro Firebase:", e);
    select.innerHTML = `<option value="">Erro ao carregar planos</option>`;
    status.className = "status erro";
    status.innerText = "Erro ao conectar com o Firebase: " + e.message;
  }
}

// ==================== GESTÃO DA EQUIPE CIRÚRGICA ====================

function tipoEsperadoNoSlot(slot) {
  return slot === "instrumentador" ? "instrumentador" : "doutor";
}

function renderizarDropdownSlot(slot) {
  const input = document.getElementById(`busca_${slot}`);
  const listaEl = document.getElementById(`lista_${slot}`);
  const termo = (input.value || "").toLowerCase().trim();
  const tipoFiltro = tipoEsperadoNoSlot(slot);

  const filtrados = todosProfissionais.filter(p => {
    if (p.tipo !== tipoFiltro) return false;
    if (!termo) return true;
    return (
      p.nome.toLowerCase().includes(termo) ||
      p.registro.toLowerCase().includes(termo) ||
      p.cpf.toLowerCase().includes(termo)
    );
  });

  if (filtrados.length === 0) {
    listaEl.innerHTML = `<div class="dropdown-empty">Nenhum ${tipoFiltro === "doutor" ? "doutor" : "instrumentador"} encontrado. Clique em <strong>+ Cadastrar</strong>.</div>`;
  } else {
    listaEl.innerHTML = filtrados.map(p => {
      const regTexto = p.tipo === "doutor"
        ? `CRO${p.uf ? "-" + p.uf : ""}: ${p.registro || "Não inf."}`
        : `COREN: ${p.registro || "Opcional"}`;
      return `
        <div class="dropdown-item" onmousedown="selecionarProfissionalSlot('${slot}', '${p.id}')">
          <strong>${escaparHtml(p.nome || "(Sem nome)")}</strong>
          <span>${escaparHtml(regTexto)} &bull; CPF: ${escaparHtml(p.cpf || "Não inf.")}</span>
        </div>
      `;
    }).join("");
  }

  listaEl.classList.remove("hidden");
}

["cirurgiao", "aux1", "aux2", "instrumentador"].forEach((slot) => {
  const input = document.getElementById(`busca_${slot}`);
  const listaEl = document.getElementById(`lista_${slot}`);

  input.addEventListener("focus", () => renderizarDropdownSlot(slot));
  input.addEventListener("click", () => renderizarDropdownSlot(slot));
  input.addEventListener("input", () => renderizarDropdownSlot(slot));
  input.addEventListener("blur", () => {
    setTimeout(() => listaEl.classList.add("hidden"), 180);
  });
});

window.selecionarProfissionalSlot = (slot, profId) => {
  const prof = todosProfissionais.find(p => p.id === profId);
  if (!prof) return;

  equipeSelecionada[slot] = { ...prof };
  document.getElementById(`busca_${slot}`).value = prof.nome;
  document.getElementById(`lista_${slot}`).classList.add("hidden");
  renderizarBoxEdicaoSlot(slot);
  atualizarTudo();
};

window.limparSlotEquipe = (slot) => {
  equipeSelecionada[slot] = null;
  document.getElementById(`busca_${slot}`).value = "";
  document.getElementById(`edit_${slot}`).innerHTML = "";
  atualizarTudo();
};

function renderizarBoxEdicaoSlot(slot) {
  const container = document.getElementById(`edit_${slot}`);
  const p = equipeSelecionada[slot];

  if (!p) {
    container.innerHTML = "";
    return;
  }

  const ehDoutor = p.tipo === "doutor";
  const optionsUf = UFS_BRASIL.map(uf => `<option value="${uf}" ${p.uf === uf ? "selected" : ""}>${uf}</option>`).join("");

  container.innerHTML = `
    <div class="edit-person-box">
      <div>
        <span class="edit-mini-label">Nome Completo</span>
        <input type="text" id="ed_nome_${slot}" value="${escaparHtml(p.nome)}" oninput="sincronizarEdicaoLocal('${slot}')">
      </div>
      ${ehDoutor ? `
        <div class="edit-row-2">
          <div style="flex: 2;">
            <span class="edit-mini-label">CRO</span>
            <input type="text" id="ed_reg_${slot}" value="${escaparHtml(p.registro)}" oninput="sincronizarEdicaoLocal('${slot}')">
          </div>
          <div style="flex: 1;">
            <span class="edit-mini-label">UF</span>
            <select id="ed_uf_${slot}" onchange="sincronizarEdicaoLocal('${slot}')">${optionsUf}</select>
          </div>
        </div>
      ` : `
        <div>
          <span class="edit-mini-label">COREN (Opcional)</span>
          <input type="text" id="ed_reg_${slot}" value="${escaparHtml(p.registro)}" oninput="sincronizarEdicaoLocal('${slot}')">
        </div>
      `}
      <div>
        <span class="edit-mini-label">CPF</span>
        <input type="text" id="ed_cpf_${slot}" maxlength="14" value="${escaparHtml(p.cpf)}" oninput="this.value = window.formatarCpfGlobal(this.value); sincronizarEdicaoLocal('${slot}')">
      </div>
      <div class="edit-actions">
        <button type="button" class="btn-save-edit" id="btn_save_${slot}" onclick="salvarEdicaoProfissional('${slot}')">Salvar Alterações</button>
        <button type="button" class="btn-clear-slot" onclick="limparSlotEquipe('${slot}')">Limpar</button>
      </div>
    </div>
  `;
}

window.formatarCpfGlobal = formatarCpf;

window.sincronizarEdicaoLocal = (slot) => {
  const p = equipeSelecionada[slot];
  if (!p) return;
  p.nome = document.getElementById(`ed_nome_${slot}`).value;
  p.registro = document.getElementById(`ed_reg_${slot}`).value;
  if (p.tipo === "doutor") {
    p.uf = document.getElementById(`ed_uf_${slot}`).value;
  }
  p.cpf = document.getElementById(`ed_cpf_${slot}`).value;
  document.getElementById(`busca_${slot}`).value = p.nome;
  atualizarTudo();
};

window.salvarEdicaoProfissional = async (slot) => {
  const p = equipeSelecionada[slot];
  if (!p || !p.id) return;

  const btn = document.getElementById(`btn_save_${slot}`);
  btn.disabled = true;
  btn.innerText = "Salvando...";

  const dadosAtualizados = {
    nome: p.nome.trim(),
    registro: p.registro.trim(),
    uf: p.tipo === "doutor" ? (p.uf || "PE") : "",
    cpf: p.cpf.trim()
  };

  try {
    await updateDoc(doc(db, "profissionais", p.id), dadosAtualizados);
    const idx = todosProfissionais.findIndex(item => item.id === p.id);
    if (idx !== -1) {
      todosProfissionais[idx] = { ...todosProfissionais[idx], ...dadosAtualizados };
    }
    ["cirurgiao", "aux1", "aux2", "instrumentador"].forEach((outroSlot) => {
      if (outroSlot !== slot && equipeSelecionada[outroSlot]?.id === p.id) {
        equipeSelecionada[outroSlot] = { ...equipeSelecionada[outroSlot], ...dadosAtualizados };
        document.getElementById(`busca_${outroSlot}`).value = dadosAtualizados.nome;
        renderizarBoxEdicaoSlot(outroSlot);
      }
    });

    btn.innerText = "✓ Salvo!";
    setTimeout(() => { btn.innerText = "Salvar Alterações"; btn.disabled = false; }, 1600);
  } catch (e) {
    console.error("Erro ao atualizar profissional:", e);
    alert("Erro ao salvar alterações: " + e.message);
    btn.innerText = "Salvar Alterações";
    btn.disabled = false;
  }
};

window.abrirModalCadastro = (tipoPadrao, slotOrigem) => {
  slotOrigemModal = slotOrigem;
  document.getElementById("cadNome").value = "";
  document.getElementById("cadCro").value = "";
  document.getElementById("cadUf").value = "PE";
  document.getElementById("cadCoren").value = "";
  document.getElementById("cadCpf").value = "";
  selecionarTipoModal(tipoPadrao);
  document.getElementById("modalCadastro").classList.remove("hidden");
  setTimeout(() => document.getElementById("cadNome").focus(), 50);
};

window.fecharModalCadastro = () => {
  document.getElementById("modalCadastro").classList.add("hidden");
};

window.selecionarTipoModal = (tipo) => {
  tipoModalAtual = tipo;
  const btnDoutor = document.getElementById("btnTipoDoutor");
  const btnInst = document.getElementById("btnTipoInstrumentador");
  const grupoCro = document.getElementById("grupoCroUf");
  const grupoCoren = document.getElementById("grupoCoren");

  if (tipo === "doutor") {
    btnDoutor.classList.add("ativo");
    btnInst.classList.remove("ativo");
    grupoCro.classList.remove("hidden");
    grupoCoren.classList.add("hidden");
  } else {
    btnInst.classList.add("ativo");
    btnDoutor.classList.remove("ativo");
    grupoCoren.classList.remove("hidden");
    grupoCro.classList.add("hidden");
  }
};

window.salvarNovoProfissional = async () => {
  const btn = document.getElementById("btnSalvarCadastro");
  btn.disabled = true;
  btn.innerText = "Salvando...";

  const novoRegistro = {
    tipo: tipoModalAtual,
    nome: document.getElementById("cadNome").value.trim(),
    registro: tipoModalAtual === "doutor"
      ? document.getElementById("cadCro").value.trim()
      : document.getElementById("cadCoren").value.trim(),
    uf: tipoModalAtual === "doutor" ? document.getElementById("cadUf").value : "",
    cpf: document.getElementById("cadCpf").value.trim(),
    criado_em: new Date().toISOString()
  };

  try {
    const docRef = await addDoc(collection(db, "profissionais"), novoRegistro);
    const salvo = { id: docRef.id, ...novoRegistro };
    todosProfissionais.push(salvo);
    todosProfissionais.sort((a, b) => a.nome.localeCompare(b.nome));
    document.getElementById("badgeProfissionais").innerText = `${todosProfissionais.length} cadastrado(s)`;

    if (tipoEsperadoNoSlot(slotOrigemModal) === salvo.tipo) {
      selecionarProfissionalSlot(slotOrigemModal, salvo.id);
    }

    fecharModalCadastro();
  } catch (e) {
    console.error("Erro ao cadastrar profissional:", e);
    alert("Erro ao cadastrar profissional: " + e.message);
  } finally {
    btn.disabled = false;
    btn.innerText = "Salvar Cadastro";
  }
};

// ==================== PROCEDIMENTOS E CÁLCULO ====================

function aoMudarPlano() {
  const plano = document.getElementById("planoSelect").value;
  const cardDisp = document.getElementById("cardDisponiveis");

  procedimentosSelecionados = [];
  uidPrincipalManual = null;
  percentuaisCustomizados = {};
  document.getElementById("buscaProcInput").value = "";

  if (!plano) {
    cardDisp.classList.add("hidden");
    atualizarTudo();
    return;
  }

  procedimentosDoPlano = todosProcedimentos
    .filter(p => p.plano === plano)
    .sort((a, b) => a.nome.localeCompare(b.nome));

  cardDisp.classList.remove("hidden");
  renderizarDisponiveis();
  atualizarTudo();
}

function renderizarDisponiveis() {
  const termo = document.getElementById("buscaProcInput").value.toLowerCase();
  const container = document.getElementById("listaDisponiveis");
  const badge = document.getElementById("badgeDisponiveis");

  const filtrados = procedimentosDoPlano.filter(p =>
    p.codigo.toLowerCase().includes(termo) || p.nome.toLowerCase().includes(termo)
  );

  badge.innerText = filtrados.length;

  if (filtrados.length === 0) {
    container.innerHTML = `<div style="padding: 14px; color: #64748b; font-size: 0.9rem;">Nenhum procedimento encontrado.</div>`;
    return;
  }

  container.innerHTML = filtrados.map(p => `
    <div class="proc-item">
      <div class="proc-info">
        <div>
          <span class="proc-code">${escaparHtml(p.codigo)}</span>
          <span class="proc-name">${escaparHtml(p.nome)}</span>
        </div>
        <div class="proc-meta">
          QTD US/URS/CRS: <strong>${formatarNumero(p.qtd_us, 2, 2)}</strong> &bull; Auxiliares: <strong>${p.quant_aux}</strong>
        </div>
      </div>
      <button type="button" class="btn-add" title="Adicionar ao Reembolso" onclick="adicionarAoReembolso('${p.id}')">+</button>
    </div>
  `).join("");
}

window.adicionarAoReembolso = (id) => {
  const item = procedimentosDoPlano.find(p => p.id === id);
  if (!item) return;

  const existente = procedimentosSelecionados.find(p => p.id === id);
  if (existente) {
    existente.vezes += 1;
  } else {
    procedimentosSelecionados.push({
      ...item,
      vezes: 1,
      quant_aux: Number(item.quant_aux) || 0,
      quant_aux_original: Number(item.quant_aux_original) || 0,
      uid: Date.now() + Math.random()
    });
  }
  atualizarTudo();
};

window.atualizarVezes = (uid, valor) => {
  const item = procedimentosSelecionados.find(p => p.uid === uid);
  if (!item) return;
  const num = parseInt(valor, 10);
  item.vezes = num >= 1 ? num : 1;
  atualizarTudo();
};

window.atualizarAuxiliares = (uid, valor) => {
  const item = procedimentosSelecionados.find(p => p.uid === uid);
  if (!item) return;
  const num = parseInt(valor, 10);
  item.quant_aux = [0, 1, 2].includes(num) ? num : 0;
  atualizarTudo();
};

window.definirPrincipalManual = (uid) => {
  uidPrincipalManual = uid;
  percentuaisCustomizados = {};
  atualizarTudo();
};

window.atualizarPercentualLinha = (chaveLinha, valorStr) => {
  const pctNum = lerDecimal(valorStr);
  if (pctNum >= 0) {
    percentuaisCustomizados[chaveLinha] = pctNum / 100;
    renderizarTabelasCalculo(obterIndicePrincipal());
  }
};

window.removerDoReembolso = (uid) => {
  if (uidPrincipalManual === uid) {
    uidPrincipalManual = null;
  }
  procedimentosSelecionados = procedimentosSelecionados.filter(p => p.uid !== uid);
  atualizarTudo();
};

document.getElementById("btnAutoPrincipal").addEventListener("click", () => {
  uidPrincipalManual = null;
  percentuaisCustomizados = {};
  atualizarTudo();
});

document.getElementById("btnResetPct").addEventListener("click", () => {
  percentuaisCustomizados = {};
  atualizarTudo();
});

document.getElementById("btnRecarregarPlanos").addEventListener("click", inicializarDados);

function calcularLinha(proc, qtdCod, percentual, valorUs, multiplo, chaveLinha = "") {
  const qtdUs = Number(proc.qtd_us) || 0;
  const qtdAux = Number(proc.quant_aux) || 0;

  const valorBaseBruto = qtdCod * qtdUs * valorUs * multiplo;
  const valorBase = arredondar2(valorBaseBruto);

  const cirurgiao = arredondar2(valorBaseBruto * percentual);
  const aux1 = qtdAux >= 1 ? arredondar2(cirurgiao * 0.30) : 0;
  const aux2 = qtdAux >= 2 ? arredondar2(cirurgiao * 0.20) : 0;
  const instrumentador = arredondar2(cirurgiao * 0.10);
  const totalLinha = arredondar2(cirurgiao + aux1 + aux2 + instrumentador);

  return {
    chaveLinha,
    codigo: proc.codigo,
    nome: proc.nome,
    qtd_cod: qtdCod,
    quant_aux: qtdAux,
    qtd_us: qtdUs,
    valor_us: valorUs,
    multiplo: multiplo,
    percentual: percentual,
    valor_base: valorBase,
    cirurgiao,
    aux1,
    aux2,
    instrumentador,
    totalLinha
  };
}

function simularTotalGeralComPrincipal(idxCandidato, valorUs, multiplo) {
  let totalGeral = 0;

  procedimentosSelecionados.forEach((proc, idx) => {
    if (idx === idxCandidato) {
      for (let i = 0; i < proc.vezes; i++) {
        const pct = i === 0 ? 1.0 : 0.5;
        totalGeral += calcularLinha(proc, 1, pct, valorUs, multiplo).totalLinha;
      }
    } else {
      totalGeral += calcularLinha(proc, proc.vezes, 0.5, valorUs, multiplo).totalLinha;
    }
  });

  return totalGeral;
}

function obterIndicePrincipal() {
  if (procedimentosSelecionados.length === 0) return -1;

  if (uidPrincipalManual !== null) {
    const idxManual = procedimentosSelecionados.findIndex(p => p.uid === uidPrincipalManual);
    if (idxManual !== -1) return idxManual;
    uidPrincipalManual = null;
  }

  const valorUsReal = lerDecimal(document.getElementById("valorUsInput").value);
  const multiploReal = lerDecimal(document.getElementById("multiploInput").value);
  const valorUsRanking = valorUsReal > 0 ? valorUsReal : 1;
  const multiploRanking = multiploReal > 0 ? multiploReal : 1;

  let indicePrincipal = 0;
  let maiorTotalGeral = -1;

  procedimentosSelecionados.forEach((_, idx) => {
    const totalCenario = simularTotalGeralComPrincipal(idx, valorUsRanking, multiploRanking);
    if (totalCenario > maiorTotalGeral) {
      maiorTotalGeral = totalCenario;
      indicePrincipal = idx;
    }
  });

  return indicePrincipal;
}

function renderizarAlertas(linhasCalculadas, valorUs, multiplo, paciente) {
  const container = document.getElementById("painelAlertas");
  const avisos = [];

  if (!paciente.trim()) {
    avisos.push("Preencha o <strong>Nome Completo do Paciente</strong> antes de gerar o relatório.");
  }

  if (valorUs <= 0) {
    avisos.push("O <strong>Valor US/URS/CRS</strong> está zerado ou vazio. Nenhum procedimento pode ser apresentado com valor R$ 0,00 à operadora.");
  }

  if (multiplo <= 0) {
    avisos.push("O <strong>Múltiplo de Reembolso (Fator)</strong> está zerado. Verifique o fator contratual do plano (geralmente 1 ou 2).");
  }

  procedimentosSelecionados.forEach((proc) => {
    const regra = REGRAS_TUSS_CONHECIDAS[proc.codigo];
    if (regra && proc.quant_aux > regra.maxAux) {
      avisos.push(`<strong>Risco de Glosa TUSS (${proc.codigo}):</strong> ${regra.motivo} Você selecionou ${proc.quant_aux} auxiliar(es).`);
    } else if (proc.quant_aux > proc.quant_aux_original) {
      avisos.push(`<strong>Atenção aos Auxiliares (${proc.codigo}):</strong> Este procedimento está cadastrado com ${proc.quant_aux_original} auxiliar(es), mas foi alterado para ${proc.quant_aux}. Auxiliares acima da tabela TUSS são glosados pela Bradesco.`);
    }
  });

  linhasCalculadas.forEach((l, index) => {
    const pctInt = Math.round(l.percentual * 100);
    if (index === 0 && pctInt !== 100) {
      avisos.push(`O procedimento principal (<strong>${l.codigo}</strong>) está com <strong>${pctInt}%</strong> em vez de 100%. Confirme se há redutor contratual na apólice.`);
    }
    if (index > 0 && pctInt > 50) {
      avisos.push(`O procedimento adicional <strong>${l.codigo}</strong> está com <strong>${pctInt}%</strong> (acima dos 50% padrão de mesma via). Percentuais como 70% ou 100% exigem comprovação de vias de acesso diferentes no boletim operatório.`);
    }
  });

  if (avisos.length === 0) {
    container.innerHTML = `
      <div class="alert-box alert-ok">
        <div class="alert-title">✓ Tudo em conformidade com as regras de cálculo da operadora</div>
        <div>Procedimento principal maximizando o retorno, equipe dentro do limite TUSS e valores arredondados por função.</div>
      </div>
    `;
  } else {
    container.innerHTML = `
      <div class="alert-box alert-warn">
        <div class="alert-title">⚠ Pontos de atenção para evitar glosas na operadora (${avisos.length}):</div>
        <ul class="alert-list">
          ${avisos.map(a => `<li>${a}</li>`).join("")}
        </ul>
      </div>
    `;
  }
}

function atualizarTudo() {
  atualizarBarraProgressoAtual();
  const idxPrincipal = obterIndicePrincipal();
  renderizarSelecionados(idxPrincipal);
  renderizarTabelasCalculo(idxPrincipal);
}

function renderizarSelecionados(idxPrincipal) {
  const cardSel = document.getElementById("cardSelecionados");
  const tbody = document.getElementById("tabelaSelecionados");
  const badge = document.getElementById("badgeSelecionados");

  badge.innerText = procedimentosSelecionados.length;

  if (procedimentosSelecionados.length === 0) {
    cardSel.classList.add("hidden");
    return;
  }

  cardSel.classList.remove("hidden");
  tbody.innerHTML = procedimentosSelecionados.map((p, idx) => {
    const ehPrincipal = idx === idxPrincipal;
    return `
      <tr style="${ehPrincipal ? 'background: #f0fdf4;' : ''}">
        <td class="center">
          <button
            type="button"
            class="btn-princ ${ehPrincipal ? 'ativo' : ''}"
            onclick="definirPrincipalManual(${p.uid})"
          >
            ${ehPrincipal ? '★ Principal' : 'Definir 1º'}
          </button>
        </td>
        <td><strong>${escaparHtml(p.codigo)}</strong></td>
        <td>${escaparHtml(p.nome)}</td>
        <td class="center">
          <input
            type="number"
            min="1"
            step="1"
            class="input-vezes"
            value="${p.vezes}"
            onchange="atualizarVezes(${p.uid}, this.value)"
            oninput="atualizarVezes(${p.uid}, this.value)"
          >
        </td>
        <td class="num">${formatarNumero(p.qtd_us, 2, 2)}</td>
        <td class="center">
          <select class="select-aux" onchange="atualizarAuxiliares(${p.uid}, this.value)">
            <option value="0" ${p.quant_aux === 0 ? 'selected' : ''}>0</option>
            <option value="1" ${p.quant_aux === 1 ? 'selected' : ''}>1</option>
            <option value="2" ${p.quant_aux === 2 ? 'selected' : ''}>2</option>
          </select>
        </td>
        <td class="center"><button type="button" class="btn-rem" onclick="removerDoReembolso(${p.uid})">Remover</button></td>
      </tr>
    `;
  }).join("");
}

function formatarResumoProfissional(p, rotulo) {
  if (!p || !p.nome) return "";
  const reg = p.tipo === "doutor"
    ? (p.registro ? ` (CRO${p.uf ? "-" + p.uf : ""}: ${p.registro})` : "")
    : (p.registro ? ` (COREN: ${p.registro})` : "");
  return `<div><strong>${rotulo}:</strong> ${escaparHtml(p.nome)}${escaparHtml(reg)}</div>`;
}

function renderizarTabelasCalculo(idxPrincipal) {
  const cardCalc = document.getElementById("cardCalculo");
  const tbodySol = document.getElementById("tabelaSolicitados");
  const tbodyRes = document.getElementById("tabelaResultados");
  const badgeInfo = document.getElementById("badgePrincipalInfo");
  const cabecalhoImg = document.getElementById("cabecalhoImagem");

  if (procedimentosSelecionados.length === 0 || idxPrincipal === -1) {
    cardCalc.classList.add("hidden");
    ultimoCalculoCache = null;
    return;
  }

  cardCalc.classList.remove("hidden");
  badgeInfo.innerText = uidPrincipalManual !== null
    ? "Modo: Principal selecionado manualmente"
    : "Modo: Automático (Maior Lucro)";

  const plano = document.getElementById("planoSelect").value || "-";
  const paciente = document.getElementById("pacienteInput").value.trim() || "Não informado";
  const cartao = document.getElementById("cartaoInput").value.trim();
  const valorUsReal = lerDecimal(document.getElementById("valorUsInput").value);
  const multiploReal = lerDecimal(document.getElementById("multiploInput").value);
  const valorUsRanking = valorUsReal > 0 ? valorUsReal : 1;
  const multiploRanking = multiploReal > 0 ? multiploReal : 1;

  const dataHoje = new Date().toLocaleDateString("pt-BR");
  const htmlEquipe = [
    formatarResumoProfissional(equipeSelecionada.cirurgiao, "Cirurgião"),
    formatarResumoProfissional(equipeSelecionada.aux1, "1º Auxiliar"),
    formatarResumoProfissional(equipeSelecionada.aux2, "2º Auxiliar"),
    formatarResumoProfissional(equipeSelecionada.instrumentador, "Instrumentador")
  ].filter(Boolean).join("");

  cabecalhoImg.innerHTML = `
    <div>
      <div><strong>Paciente:</strong> ${escaparHtml(paciente)}${cartao ? ` &nbsp;|&nbsp; <strong>Cartão:</strong> ${escaparHtml(cartao)}` : ""}</div>
      ${htmlEquipe}
    </div>
    <div style="text-align: right;">
      <div><strong>Plano:</strong> ${escaparHtml(plano)}</div>
      <div><strong>Data:</strong> ${dataHoje}</div>
    </div>
  `;

  const principal = procedimentosSelecionados[idxPrincipal];
  const secundarios = procedimentosSelecionados
    .filter((_, idx) => idx !== idxPrincipal)
    .sort((a, b) => {
      const retA = calcularLinha(a, a.vezes, 0.5, valorUsRanking, multiploRanking).totalLinha;
      const retB = calcularLinha(b, b.vezes, 0.5, valorUsRanking, multiploRanking).totalLinha;
      return retB - retA;
    });

  const linhasCalculadas = [];

  for (let i = 0; i < principal.vezes; i++) {
    const chave = `${principal.uid}_${i}`;
    const pctPadrao = i === 0 ? 1.0 : 0.5;
    const pct = percentuaisCustomizados[chave] !== undefined ? percentuaisCustomizados[chave] : pctPadrao;
    const linha = calcularLinha(principal, 1, pct, valorUsReal, multiploReal, chave);
    linha.isPrincipal = true;
    linhasCalculadas.push(linha);
  }

  secundarios.forEach((proc) => {
    const chave = `${proc.uid}_0`;
    const pct = percentuaisCustomizados[chave] !== undefined ? percentuaisCustomizados[chave] : 0.5;
    const linha = calcularLinha(proc, proc.vezes, pct, valorUsReal, multiploReal, chave);
    linha.isPrincipal = false;
    linhasCalculadas.push(linha);
  });

  renderizarAlertas(linhasCalculadas, valorUsReal, multiploReal, paciente);

  // Tabela 1: Procedimentos Solicitados
  tbodySol.innerHTML = linhasCalculadas.map(l => `
    <tr>
      <td><strong>${escaparHtml(l.codigo)}</strong></td>
      <td>
        ${escaparHtml(l.nome)}
        ${l.isPrincipal ? '<span class="tag-principal">PRINCIPAL</span>' : ''}
      </td>
      <td class="center"><strong>${l.qtd_cod}</strong></td>
      <td class="center">${l.quant_aux}</td>
      <td class="num">${formatarNumero(l.qtd_us, 2, 2)}</td>
      <td class="num">${formatarNumero(l.valor_us, 2, 6)}</td>
      <td class="center">${formatarNumero(l.multiplo, 2, 4)}</td>
      <td class="center">
        <input
          type="text"
          inputmode="decimal"
          class="input-pct"
          value="${formatarNumero(l.percentual * 100, 0, 2)}"
          onchange="atualizarPercentualLinha('${l.chaveLinha}', this.value)"
          title="Edite o percentual desta linha (ex: 100, 70, 50)"
        >%
      </td>
    </tr>
  `).join("");

  // Tabela 2: Cálculo Exato
  let totCirurgiao = 0;
  let totAux1 = 0;
  let totAux2 = 0;
  let totInst = 0;

  const htmlLinhasRes = linhasCalculadas.map(l => {
    totCirurgiao = arredondar2(totCirurgiao + l.cirurgiao);
    totAux1 = arredondar2(totAux1 + l.aux1);
    totAux2 = arredondar2(totAux2 + l.aux2);
    totInst = arredondar2(totInst + l.instrumentador);

    return `
      <tr>
        <td><strong>${escaparHtml(l.codigo)}</strong></td>
        <td>${escaparHtml(l.nome)}</td>
        <td class="num">${formatarMoeda(l.valor_base)}</td>
        <td class="num">${formatarMoeda(l.cirurgiao)}</td>
        <td class="num ${l.aux1 === 0 ? 'sub-zero' : ''}">${formatarMoeda(l.aux1)}</td>
        <td class="num ${l.aux2 === 0 ? 'sub-zero' : ''}">${formatarMoeda(l.aux2)}</td>
        <td class="num">${formatarMoeda(l.instrumentador)}</td>
      </tr>
    `;
  }).join("");

  const totalGeral = arredondar2(totCirurgiao + totAux1 + totAux2 + totInst);

  ultimoCalculoCache = {
    plano,
    paciente,
    cartao,
    valorUsReal,
    multiploReal,
    linhasCalculadas,
    totCirurgiao,
    totAux1,
    totAux2,
    totInst,
    totalGeral
  };

  tbodyRes.innerHTML = htmlLinhasRes + `
    <tr class="row-total">
      <td colspan="3" class="num">TOTAL POR EQUIPE</td>
      <td class="num">${formatarMoeda(totCirurgiao)}</td>
      <td class="num">${formatarMoeda(totAux1)}</td>
      <td class="num">${formatarMoeda(totAux2)}</td>
      <td class="num">${formatarMoeda(totInst)}</td>
    </tr>
    <tr class="row-total-geral">
      <td colspan="6" class="num">TOTAL GERAL DO REEMBOLSO</td>
      <td class="num">${formatarMoeda(totalGeral)}</td>
    </tr>
  `;
}

// ==================== MONTAGEM E EXPORTAÇÃO DO PDF OFICIAL ====================

function montarLinhasEquipePdf(calc) {
  const linhas = [];

  const adicionarMembro = (rotulo, pessoa, valor) => {
    if (!pessoa && valor <= 0) return;
    const nomeExibir = pessoa?.nome ? pessoa.nome.toUpperCase() : "NÃO INFORMADO";
    let docExibir = "";
    if (pessoa) {
      if (pessoa.tipo === "doutor") {
        const croPart = pessoa.registro ? `CRO${pessoa.uf ? "/" + pessoa.uf.toUpperCase() : ""}: ${pessoa.registro}` : "";
        const cpfPart = pessoa.cpf ? `CPF: ${pessoa.cpf}` : "";
        docExibir = [croPart, cpfPart].filter(Boolean).join(" &nbsp;|&nbsp; ");
      } else {
        const corenPart = pessoa.registro ? `COREN: ${pessoa.registro}` : "";
        const cpfPart = pessoa.cpf ? `CPF: ${pessoa.cpf}` : "";
        docExibir = [corenPart, cpfPart].filter(Boolean).join(" &nbsp;|&nbsp; ");
      }
    }
    linhas.push(`
      <tr>
        <td class="pdf-team-role">${rotulo}:</td>
        <td class="pdf-team-name">${escaparHtml(nomeExibir)}</td>
        <td class="pdf-team-reg">${docExibir || "-"}</td>
        <td class="pdf-team-val">VALOR: ${formatarMoeda(valor)}</td>
      </tr>
    `);
  };

  adicionarMembro("CIRURGIÃO", equipeSelecionada.cirurgiao, calc.totCirurgiao);
  if (equipeSelecionada.aux1 || calc.totAux1 > 0) {
    adicionarMembro("1º AUXILIAR", equipeSelecionada.aux1, calc.totAux1);
  }
  if (equipeSelecionada.aux2 || calc.totAux2 > 0) {
    adicionarMembro("2º AUXILIAR", equipeSelecionada.aux2, calc.totAux2);
  }
  if (equipeSelecionada.instrumentador || calc.totInst > 0) {
    adicionarMembro("INSTRUMENTADOR(A)", equipeSelecionada.instrumentador, calc.totInst);
  }

  return linhas.join("");
}

function construirHtmlDocumentoPdf(calc) {
  const linhasTabela1Html = calc.linhasCalculadas.map(l => `
    <tr>
      <td class="pdf-col-code">${escaparHtml(l.codigo)}</td>
      <td class="pdf-col-desc">${escaparHtml(l.nome.toUpperCase())}</td>
      <td class="pdf-col-center">${l.qtd_cod}</td>
      <td class="pdf-col-center">${l.quant_aux}</td>
      <td class="pdf-col-right">${formatarNumero(l.qtd_us, 2, 2)}</td>
      <td class="pdf-col-right">${formatarNumero(l.valor_us, 2, 6)}</td>
      <td class="pdf-col-center">${formatarNumero(l.multiplo, 0, 4)}</td>
      <td class="pdf-col-center">${formatarNumero(l.percentual * 100, 0, 2)}%</td>
    </tr>
  `).join("");

  const linhasTabela2Html = calc.linhasCalculadas.map(l => `
    <tr>
      <td class="pdf-col-code">${escaparHtml(l.codigo)}</td>
      <td class="pdf-col-center">${l.qtd_cod}</td>
      <td class="pdf-col-right">${formatarMoeda(l.cirurgiao)}</td>
      <td class="pdf-col-right">${formatarMoeda(l.aux1)}</td>
      <td class="pdf-col-right">${formatarMoeda(l.aux2)}</td>
      <td class="pdf-col-right">${formatarMoeda(l.instrumentador)}</td>
    </tr>
  `).join("");

  const equipeHtml = montarLinhasEquipePdf(calc);

  return `
    <div class="pdf-doc-header">
      <h1>RELATÓRIO EXPLICATIVO DE ORÇAMENTO PARA CIRURGIA HOSPITALAR</h1>
    </div>

    <table class="pdf-patient-grid">
      <tr>
        <td style="width: 58%;">
          <span class="pdf-field-label">Paciente</span>
          <span class="pdf-field-value">${escaparHtml(calc.paciente.toUpperCase())}</span>
        </td>
        <td style="width: 42%;">
          <span class="pdf-field-label">Cartão</span>
          <span class="pdf-field-value">${escaparHtml(calc.cartao || "-")}</span>
        </td>
      </tr>
      <tr>
        <td>
          <span class="pdf-field-label">Plano</span>
          <span class="pdf-field-value">${escaparHtml(calc.plano.toUpperCase())}</span>
        </td>
        <td>
          <span class="pdf-field-label">Múltiplo / Valor US/URS/CRS</span>
          <span class="pdf-field-value">${formatarNumero(calc.multiploReal, 0, 4)} &nbsp;/&nbsp; ${formatarNumero(calc.valorUsReal, 2, 6)}</span>
        </td>
      </tr>
    </table>

    <div class="pdf-intro-box">
      <p>Em casos de procedimentos e/ou exames diversos no mesmo evento médico, o cálculo dos demais procedimentos deve seguir o percentual previsto nas Condições Gerais da Tabela. O valor apurado pode incidir coparticipação, se houver.</p>
      <p>Com base nas informações sobre valores de coeficientes e múltiplos de reembolso fornecidos pela operadora Bradesco Saúde através do site <strong>https://www.bradescosaude.com.br</strong>; este orçamento foi emitido com base na seguinte fórmula: <strong>Valor US/URS/CRS x Quantidade US/URS/CRS x Múltiplo de Reembolso = Valor a ser reembolsado.</strong></p>
    </div>

    <div class="pdf-table-block">
      <div class="pdf-section-title">PROCEDIMENTO(S) SOLICITADO(S)</div>
      <table class="pdf-data-table">
        <thead>
          <tr>
            <th style="width: 11%;">CÓDIGO</th>
            <th class="col-desc-header" style="width: 35%;">DESCRIÇÃO</th>
            <th style="width: 7%;">QTD<br>COD</th>
            <th style="width: 7%;">QTD<br>AUX</th>
            <th style="width: 12%;">QTD<br>US/URS/CRS</th>
            <th style="width: 11%;">VALOR<br>US/URS/CRS</th>
            <th style="width: 10%;">MÚLTIPLO<br>REEMB.</th>
            <th style="width: 7%;">(%)</th>
          </tr>
        </thead>
        <tbody>
          ${linhasTabela1Html}
        </tbody>
      </table>
    </div>

    ${HTML_GLOSSARIO_E_NORMAS}

    <div class="pdf-table-block">
      <div class="pdf-section-title">CÁLCULO EXATO DO REEMBOLSO BASEADO NAS INFORMAÇÕES FORNECIDAS PELA OPERADORA</div>
      <table class="pdf-data-table">
        <thead>
          <tr>
            <th style="width: 15%;">CÓDIGO</th>
            <th style="width: 13%;">Q. COD<br>AUTORIZADO</th>
            <th style="width: 18%;">CIRURGIÃO</th>
            <th style="width: 18%;">AUXILIAR 1 (30%)</th>
            <th style="width: 18%;">AUXILIAR 2 (20%)</th>
            <th style="width: 18%;">INSTRUMENTADOR (10%)</th>
          </tr>
        </thead>
        <tbody>
          ${linhasTabela2Html}
          <tr class="pdf-row-subtotal">
            <td colspan="2" class="pdf-col-center">TOTAL</td>
            <td class="pdf-col-right">${formatarMoeda(calc.totCirurgiao)}</td>
            <td class="pdf-col-right">${formatarMoeda(calc.totAux1)}</td>
            <td class="pdf-col-right">${formatarMoeda(calc.totAux2)}</td>
            <td class="pdf-col-right">${formatarMoeda(calc.totInst)}</td>
          </tr>
          <tr class="pdf-row-grandtotal">
            <td colspan="5" style="text-align: right; padding-right: 12px;">TOTAL GERAL DO ORÇAMENTO</td>
            <td class="pdf-col-right">${formatarMoeda(calc.totalGeral)}</td>
          </tr>
        </tbody>
      </table>
      ${equipeHtml ? `
        <div class="pdf-team-box">
          <table class="pdf-team-table">
            ${equipeHtml}
          </table>
        </div>
      ` : ""}
    </div>

    ${HTML_CONDICOES_GERAIS_BRADESCO}
  `;
}

function gerarNomeArquivoPdf(paciente) {
  const nomeLimpo = (paciente || "REEMBOLSO")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `RELATORIO_REEMBOLSO_${nomeLimpo || "PACIENTE"}.pdf`;
}

document.getElementById("btnGerarPdf").addEventListener("click", () => {
  if (!ultimoCalculoCache || ultimoCalculoCache.linhasCalculadas.length === 0) {
    alert("Adicione pelo menos um procedimento antes de gerar o PDF.");
    return;
  }

  const calc = ultimoCalculoCache;
  const printContainer = document.getElementById("printDocument");
  printContainer.innerHTML = construirHtmlDocumentoPdf(calc);

  const tituloOriginal = document.title;
  document.title = gerarNomeArquivoPdf(calc.paciente).replace(/\.pdf$/i, "");

  window.print();

  setTimeout(() => {
    document.title = tituloOriginal;
  }, 500);
});

document.getElementById("btnEnviarPdfWhatsapp").addEventListener("click", async () => {
  if (!ultimoCalculoCache || ultimoCalculoCache.linhasCalculadas.length === 0) {
    alert("Adicione pelo menos um procedimento antes de enviar o PDF.");
    return;
  }

  if (typeof html2pdf === "undefined") {
    alert("A biblioteca de geração de PDF ainda está carregando. Tente novamente em 2 segundos.");
    return;
  }

  const btn = document.getElementById("btnEnviarPdfWhatsapp");
  const statusEl = document.getElementById("statusPdfWhatsapp");
  const textoOriginal = btn.innerHTML;

  btn.disabled = true;
  btn.innerText = "Gerando arquivo PDF...";
  statusEl.innerText = "";

  const calc = ultimoCalculoCache;
  const nomeArquivo = gerarNomeArquivoPdf(calc.paciente);

  const scrollAnteriorX = window.scrollX;
  const scrollAnteriorY = window.scrollY;
  window.scrollTo(0, 0);

  const mainContainer = document.querySelector(".container.no-print");
  if (mainContainer) mainContainer.style.display = "none";

  const tempWrapper = document.createElement("div");
  tempWrapper.style.position = "relative";
  tempWrapper.style.width = "182mm";
  tempWrapper.style.margin = "0 auto";
  tempWrapper.style.background = "#ffffff";
  tempWrapper.className = "pdf-render-scope";
  tempWrapper.innerHTML = construirHtmlDocumentoPdf(calc);

  document.body.appendChild(tempWrapper);

  await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 150)));

  try {
    const opt = {
      margin: [14, 14, 14, 14],
      filename: nomeArquivo,
      image: { type: "jpeg", quality: 0.98 },
      html2canvas: {
        scale: 2,
        useCORS: true,
        logging: false,
        scrollX: 0,
        scrollY: 0,
        windowWidth: 800,
        backgroundColor: "#ffffff"
      },
      jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
      pagebreak: {
        mode: ["css", "legacy"],
        avoid: [".pdf-table-block", "tr", ".pdf-glossary-box", ".pdf-team-box", ".pdf-norm-p", ".pdf-norm-sub"]
      }
    };

    const pdfBlob = await html2pdf().set(opt).from(tempWrapper).outputPdf("blob");
    const arquivoPdf = new File([pdfBlob], nomeArquivo, { type: "application/pdf" });

    if (navigator.canShare && navigator.canShare({ files: [arquivoPdf] })) {
      await navigator.share({
        files: [arquivoPdf],
        title: "Relatório Explicativo de Orçamento",
        text: `Relatório de Reembolso - ${calc.paciente}`
      });
      statusEl.innerText = "✓ PDF compartilhado!";
    } else {
      const urlBlob = URL.createObjectURL(pdfBlob);
      const link = document.createElement("a");
      link.href = urlBlob;
      link.download = nomeArquivo;
      link.click();

      window.open("https://web.whatsapp.com/", "_blank");
      statusEl.innerText = `✓ Arquivo "${nomeArquivo}" baixado! Arraste ou anexe o PDF na conversa do WhatsApp Web.`;
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error("Erro ao gerar PDF para WhatsApp:", err);
      alert("Erro ao gerar PDF: " + err.message);
    }
  } finally {
    if (tempWrapper.parentNode) document.body.removeChild(tempWrapper);
    if (mainContainer) mainContainer.style.display = "";
    window.scrollTo(scrollAnteriorX, scrollAnteriorY);
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
});

document.getElementById("btnEnviarWhatsapp").addEventListener("click", async () => {
  const btn = document.getElementById("btnEnviarWhatsapp");
  const statusWa = document.getElementById("statusWhatsapp");
  const area = document.getElementById("areaCapturaTabela2");

  if (typeof html2canvas === "undefined") {
    alert("A biblioteca de geração de imagem ainda está carregando. Tente novamente em 2 segundos.");
    return;
  }

  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerText = "Gerando imagem...";
  statusWa.innerText = "";

  const nomePacienteRaw = document.getElementById("pacienteInput").value.trim();
  const nomePacienteTexto = nomePacienteRaw || "Não informado";
  const { faltando } = atualizarBarraProgressoAtual();

  const statusDadosTexto = faltando.length === 0
    ? "TODOS OS DADOS PREENCHIDOS!"
    : `Faltam preencher: ${faltando.join(", ")}`;

  const mensagemWhatsapp = `*Paciente:* ${nomePacienteTexto}\n${statusDadosTexto}`;

  try {
    const canvas = await html2canvas(area, {
      scale: 2,
      backgroundColor: "#ffffff",
      windowWidth: Math.max(area.scrollWidth + 60, 1100)
    });

    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    const nomePacienteArquivo = (nomePacienteRaw || "reembolso")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, "_");
    const nomeArquivo = `calculo_reembolso_${nomePacienteArquivo}.png`;
    const arquivo = new File([blob], nomeArquivo, { type: "image/png" });

    if (navigator.canShare && navigator.canShare({ files: [arquivo] })) {
      await navigator.share({
        files: [arquivo],
        title: "Cálculo Exato do Reembolso",
        text: mensagemWhatsapp
      });
      statusWa.innerText = "✓ Imagem e texto compartilhados!";
    } else {
      const link = document.createElement("a");
      link.download = nomeArquivo;
      link.href = URL.createObjectURL(blob);
      link.click();

      let textoCopiado = false;
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(mensagemWhatsapp);
          textoCopiado = true;
        }
      } catch (clipErr) {
        console.warn("Clipboard de texto não permitido:", clipErr);
      }

      window.open("https://web.whatsapp.com/", "_blank");
      statusWa.innerText = textoCopiado
        ? `✓ Imagem baixada e texto copiado! (${nomePacienteTexto} — ${statusDadosTexto})`
        : `✓ Imagem baixada! Mensagem: ${nomePacienteTexto} — ${statusDadosTexto}`;
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error(err);
      alert("Erro ao gerar imagem da tabela: " + err.message);
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
});

document.getElementById("planoSelect").addEventListener("change", aoMudarPlano);
document.getElementById("buscaProcInput").addEventListener("input", renderizarDisponiveis);
document.getElementById("pacienteInput").addEventListener("input", atualizarTudo);
document.getElementById("cartaoInput").addEventListener("input", atualizarTudo);
document.getElementById("valorUsInput").addEventListener("input", atualizarTudo);
document.getElementById("multiploInput").addEventListener("input", atualizarTudo);

atualizarBarraProgressoAtual();
inicializarDados();
