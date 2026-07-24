/* CONFIG — Supabase (mesmo projeto do SplitBill, schema dedicado 'festasbv') */
const SB_URL = 'https://gjweqwfbnkgnibhajldc.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdqd2Vxd2ZibmtnbmliaGFqbGRjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMDk4NzUsImV4cCI6MjA5NjY4NTg3NX0.h6st-RayGhQdsqH7E2Ko-rPWk2QZUpTevO6cbjvlSnk';
const ADMIN_EMAIL = 'diogo.andre.f.silva@gmail.com';
const SESSION_KEY = 'festasbv_sb_session';
// Etiqueta de versão — visível em Definições › Conta. Bump a cada deploy relevante
// para se confirmar de imediato se o telemóvel já tem a build nova.
const APP_BUILD = 'v76 · 2026-07-24 · Lista durável: pedidos cobertos pelo stock ficam "tratados" e voltam sozinhos se a alocação mudar';
let _sbSession = null;
let _writeChain = Promise.resolve(true);   // fila de escritas serializada (padrão Expenses-Acc)
let _writeBusy = 0;

function sbHeaders(extra = {}) {
  const h = {
    'Content-Type': 'application/json',
    'apikey': SB_KEY,
    'Authorization': `Bearer ${_sbSession?.access_token || SB_KEY}`,
    'Accept-Profile': 'festasbv',     // schema dedicado: vai nos headers, NUNCA no URL
    'Content-Profile': 'festasbv'
  };
  return Object.assign(h, extra);
}

/* ── Sessão: refresh automático (o access token expira em ~1h) ── */
function sbSaveSession(s){
  _sbSession=s;
  localStorage.setItem(SESSION_KEY,JSON.stringify(s));
}
let _refreshing=null;   // evita refreshes concorrentes (o refresh_token é de uso único)
async function sbRefresh(){
  if(!_sbSession||!_sbSession.refresh_token)return false;
  if(_refreshing)return _refreshing;
  _refreshing=(async()=>{
    try{
      const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`,{
        method:'POST',
        headers:{'apikey':SB_KEY,'Content-Type':'application/json'},
        body:JSON.stringify({refresh_token:_sbSession.refresh_token})
      });
      if(!r.ok)return false;
      const d=await r.json();
      sbSaveSession({
        access_token:d.access_token,
        refresh_token:d.refresh_token||_sbSession.refresh_token,
        expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),
        user:d.user||_sbSession.user
      });
      return true;
    }catch(e){return false;}
  })();
  const ok=await _refreshing;
  _refreshing=null;
  return ok;
}
function tokenQuaseExpirado(){
  // Sem expires_at (sessões antigas) assume-se que pode estar expirado
  if(!_sbSession)return false;
  if(!_sbSession.expires_at)return true;
  return (_sbSession.expires_at-Date.now()/1000)<120;
}
async function sbEnsureFresh(){
  if(_sbSession&&_sbSession.refresh_token&&tokenQuaseExpirado())await sbRefresh();
}
// fetch para o REST: garante token fresco e, se ainda assim vier 401, faz refresh + 1 retry
async function sbFetch(url,opt){
  await sbEnsureFresh();
  opt=opt||{};
  opt.headers=Object.assign({},opt.headers,{'Authorization':`Bearer ${_sbSession?.access_token||SB_KEY}`});
  let r=await fetch(url,opt);
  if(r.status===401&&_sbSession&&_sbSession.refresh_token){
    const ok=await sbRefresh();
    if(ok){
      opt.headers['Authorization']=`Bearer ${_sbSession.access_token}`;
      r=await fetch(url,opt);
    }
  }
  return r;
}
// Refresh preventivo: a cada 10 min e sempre que a PWA volta ao ecrã
setInterval(()=>{sbEnsureFresh();},10*60*1000);


/* STATE */
let ALL_YEARS=[];
let YEAR_IDX=0;
let DATA=null,CALC=null,TAB='saldos',GH_SHA=null;
// Persistência do estado de navegação (sobrevive ao reload do PWA quando o iOS o descarrega)
function lsSet(k,v){try{localStorage.setItem(k,v);}catch(_){}}
function lsGet(k){try{return localStorage.getItem(k);}catch(_){return null;}}

/* ── Permissões: utilizadores ↔ membros ↔ casais ── */
let USER_AMIGOS=[];   // [{email,amigo}]
let CONJUGES=[];      // [{amigo_a,amigo_b}]
let VALIDACOES=[];    // [{evento_id,amigo,validado_por_email,validado_em}]
let MY_NAMES=[];      // nomes que o utilizador atual pode gerir (próprio + cônjuge)
let REFDEF_RESP_COLS=false;   // BD já tem resp_cozinha/resp_compras? (migração db/notifs.sql)
let STOCK_TABLE=false;        // BD já tem stock_lotes? (migração SQL do stock por refeição)
const enc=encodeURIComponent;

function isAdmin(){return !!_sbSession&&_sbSession.user.email===ADMIN_EMAIL;}
function hojeISO(){const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');}
function computeMyNames(){
  MY_NAMES=[];
  if(!_sbSession)return;
  const me=USER_AMIGOS.find(u=>u.email===_sbSession.user.email);
  if(!me)return;
  const s=new Set([me.amigo]);
  CONJUGES.forEach(c=>{if(c.amigo_a===me.amigo)s.add(c.amigo_b);if(c.amigo_b===me.amigo)s.add(c.amigo_a);});
  MY_NAMES=[...s];
}
function diaEditavel(dia){
  const rd=(DATA&&DATA.refeicoesDef||[]).find(r=>r.dia===dia);
  return !!rd&&rd.data>=hojeISO();
}
// Nome do amigo (membro) associado ao utilizador logado — usado como default em "quem paga/recebe"
function myPrimaryName(){
  if(!DATA||!MY_NAMES.length)return'';
  const names=(DATA.membros||[]).map(m=>m.nome);
  return MY_NAMES.find(n=>names.includes(n))||'';
}
function canTouchPresenca(nome,dia){return isAdmin()||(MY_NAMES.includes(nome)&&diaEditavel(dia));}
function permErrorMsg(e){
  const m=(e&&e.message||'')+'';
  if(/row-level security|42501|permission/i.test(m))return 'Sem permissão para esta alteração (ou a data já passou)';
  return 'Erro: '+m;
}

/* ── Fecho de contas + validação ── */
function contasFechadas(){return !!(DATA&&DATA.evento&&DATA.evento.contasFechadas);}
function ultimaRefeicaoISO(){const ds=(DATA&&DATA.refeicoesDef||[]).map(r=>r.data).filter(Boolean);return ds.length?ds.slice().sort().slice(-1)[0]:null;}
function temDespesasPendentes(){return (DATA&&DATA.despesas||[]).some(d=>!d.dataValor);}  // sem data-valor = pagamento ainda não efetivo
function podeFecharContas(){
  if(!isAdmin()||!DATA||!DATA._sbId)return false;
  if(contasFechadas())return false;
  const ult=ultimaRefeicaoISO();
  if(!ult||hojeISO()<ult)return false;
  if(temDespesasPendentes())return false;
  return true;
}
function dividasTodasSaldadas(){
  if(!CALC||!CALC.membros||!CALC.membros.length)return false;
  return CALC.membros.every(m=>typeof m._sfEcra==='number'&&Math.abs(m._sfEcra)<0.005);
}
// Nomes cujas contas o utilizador atual pode validar (próprio + cônjuge; admin também os amigos sem utilizador)
function nomesValidaveis(){
  if(!_sbSession)return[];
  const s=new Set(MY_NAMES);
  if(isAdmin())amigosSemUtilizador().forEach(n=>s.add(n));
  return [...s];
}
// Ainda há contas (das que o utilizador pode validar) por validar?
function temContasPorValidar(){
  const alvo=nomesValidaveis();
  if(!alvo.length)return false;
  const validados=new Set(validacoesDoAno().map(v=>v.amigo));
  return alvo.some(n=>!validados.has(n));
}
function validacoesDoAno(){if(!DATA||!DATA._sbId)return[];return VALIDACOES.filter(v=>v.evento_id===DATA._sbId);}
function meuNomePrincipal(){if(!_sbSession)return'';const me=USER_AMIGOS.find(u=>u.email===_sbSession.user.email);return me?me.amigo:'';}
function fmtDataHora(iso){if(!iso)return'';const d=new Date(iso);if(isNaN(d))return'';return d.toLocaleDateString('pt-PT')+' '+d.toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'});}
function amigoTemUtilizador(nome){return USER_AMIGOS.some(u=>u.amigo===nome);}
function conjugeDe(nome){for(const c of CONJUGES){if(c.amigo_a===nome)return c.amigo_b;if(c.amigo_b===nome)return c.amigo_a;}return null;}
// O agregado (próprio + cônjuge) tem pelo menos um utilizador ativo?
function agregadoTemUtilizador(nome){if(amigoTemUtilizador(nome))return true;const c=conjugeDe(nome);return c?amigoTemUtilizador(c):false;}
// Amigos que o admin pode validar: membros sem utilizador no agregado, fora do próprio agregado do admin.
function amigosSemUtilizador(){
  if(!isAdmin()||!DATA)return[];
  const out=[];
  (DATA.membros||[]).forEach(m=>{
    const n=m.nome;
    if(!n||MY_NAMES.includes(n)||agregadoTemUtilizador(n))return;
    if(out.indexOf(n)<0)out.push(n);
  });
  return out;
}

function updateContasUI(){
  const fechadas=contasFechadas();
  document.body.classList.toggle('contas-fechadas',fechadas);
  document.body.classList.toggle('dividas-saldadas',dividasTodasSaldadas());
  // Compras não faz sentido em anos fechados — esconde o tab (e sai dele se lá estiver)
  const comprasTab=document.querySelector('.tab[data-tab="compras"]');
  if(comprasTab)comprasTab.style.display=fechadas?'none':'';
  if(fechadas&&TAB==='compras')setTab('saldos');
}

async function fecharContas(){
  if(!isAdmin()||!DATA||!DATA._sbId)return;
  if(!podeFecharContas()){toast('Ainda não é possível fechar as contas','bad');return;}
  if(!confirm('Fechar as contas deste ano?\n\nO ano deixa de ser editável (até para ti). Só os pagamentos de dívidas continuam possíveis. Podes reabrir a qualquer momento.'))return;
  const agora=new Date().toISOString();
  setSync('load','a guardar…');
  try{
    await queueWrite(()=>sbReq('PATCH',`eventos?id=eq.${DATA._sbId}`,{contas_fechadas:true,contas_fechadas_em:agora,contas_fechadas_por:_sbSession.user.email}));
    DATA.evento.contasFechadas=true;DATA.evento.contasFechadasEm=agora;DATA.evento.contasFechadasPor=_sbSession.user.email;
    syncMirror();marcaGuardado();renderAll();toast('Contas fechadas 🔒','ok');
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');}
}
async function reabrirContas(){
  if(!isAdmin()||!DATA||!DATA._sbId)return;
  if(!confirm('Reabrir as contas deste ano? O ano volta a ficar editável.'))return;
  setSync('load','a guardar…');
  try{
    await queueWrite(()=>sbReq('PATCH',`eventos?id=eq.${DATA._sbId}`,{contas_fechadas:false,contas_fechadas_em:null,contas_fechadas_por:null}));
    DATA.evento.contasFechadas=false;DATA.evento.contasFechadasEm=null;DATA.evento.contasFechadasPor=null;
    syncMirror();marcaGuardado();renderAll();toast('Contas reabertas 🔓','ok');
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');}
}

function valOptRow(nome,name,sub,sel){
  const dn=(nome||'').replace(/"/g,'&quot;');
  return `<div class="val-opt${sel?' sel':''}" data-nome="${dn}" onclick="toggleValOpt(this)">
    <span class="vo-check">✓</span>
    <span class="vo-label"><span class="vo-name">${name}</span>${sub?`<span class="vo-sub">${sub}</span>`:''}</span>
  </div>`;
}
function valSyncLink(block){
  const link=block.querySelector('.vb-link');if(!link)return;
  const opts=block.querySelectorAll('.val-opt');
  const allSel=opts.length&&[...opts].every(o=>o.classList.contains('sel'));
  link.textContent=allSel?'Desmarcar todos':'Marcar todos';
}
function toggleValOpt(el){el.classList.toggle('sel');const b=el.closest('.val-block');if(b)valSyncLink(b);}
function valBlockToggle(btn){
  const b=btn.closest('.val-block');if(!b)return;
  const opts=b.querySelectorAll('.val-opt');
  const allSel=opts.length&&[...opts].every(o=>o.classList.contains('sel'));
  opts.forEach(o=>o.classList.toggle('sel',!allSel));
  valSyncLink(b);
}
function abrirValModal(){
  if(!_sbSession){toast('Inicia sessão para validar','bad');return;}
  if(!contasFechadas()){toast('Só podes validar depois de as contas estarem fechadas','bad');return;}
  const admin=isAdmin();
  const meuNome=meuNomePrincipal();
  const conj=MY_NAMES.filter(n=>n!==meuNome);
  const semUser=admin?amigosSemUtilizador():[];
  const temProprias=!!(meuNome||conj.length);
  let f='';
  if(temProprias){
    f+='<div class="val-block">';
    if(admin&&semUser.length)f+='<div class="val-block-t">As tuas contas</div>';
    if(meuNome)f+=valOptRow(meuNome,'As minhas contas',meuNome,true);
    conj.forEach(n=>{f+=valOptRow(n,n,'cônjuge',true);});
    f+='</div>';
  }
  if(semUser.length){
    f+='<div class="val-block">';
    f+='<div class="val-block-t"'+(temProprias?' style="margin-top:18px"':'')+'><span>Amigos sem utilizador</span>'+(semUser.length>1?'<button class="vb-link" onclick="valBlockToggle(this)">Desmarcar todos</button>':'')+'</div>';
    semUser.forEach(n=>{const c=conjugeDe(n);f+=valOptRow(n,n,c?('c/ '+c):'',true);});
    f+='</div>';
  }
  const temAlgo=temProprias||semUser.length;
  if(!temAlgo)f='<div class="empty">Não há contas que possas validar. Liga a tua conta a um membro nas Definições.</div>';
  document.getElementById('val-form').innerHTML=f;
  document.getElementById('val-save').style.display=temAlgo?'':'none';
  document.getElementById('val-bg').classList.add('show');
  document.body.classList.add('no-scroll');
}
function closeValModal(){document.getElementById('val-bg').classList.remove('show');document.body.classList.remove('no-scroll');}
function confirmarValidacaoUI(){
  const amigos=[];
  document.querySelectorAll('#val-form .val-opt.sel').forEach(c=>{const n=c.dataset.nome;if(n&&amigos.indexOf(n)<0)amigos.push(n);});
  if(!amigos.length){toast('Nada selecionado para validar','bad');return;}
  closeValModal();
  confirmarValidacao(amigos);
}
async function confirmarValidacao(amigos){
  if(!_sbSession){toast('Sessão expirada — volta a entrar','bad');return;}
  if(!DATA||!DATA._sbId){toast('Sem ligação à base de dados — recarrega','bad');return;}
  if(!contasFechadas()){toast('Só podes validar com as contas fechadas','bad');return;}
  const email=_sbSession.user.email;
  const porAmigo=meuNomePrincipal();
  const agora=new Date().toISOString();
  const rows=amigos.map(a=>({evento_id:DATA._sbId,amigo:a,validado_por_email:email,validado_por_amigo:porAmigo,validado_em:agora}));
  setSync('load','a guardar…');
  try{
    const ret=await queueWrite(()=>sbReq('POST','validacoes?on_conflict=evento_id,amigo',rows,{Prefer:'resolution=merge-duplicates,return=representation'}));
    rows.forEach(r=>{
      const fromRet=(Array.isArray(ret)?ret.find(x=>x.evento_id===r.evento_id&&x.amigo===r.amigo):null)||r;
      const i=VALIDACOES.findIndex(v=>v.evento_id===r.evento_id&&v.amigo===r.amigo);
      if(i>=0)VALIDACOES[i]=Object.assign({},VALIDACOES[i],fromRet);else VALIDACOES.push(fromRet);
    });
    marcaGuardado();renderAll();toast(amigos.length>1?'Contas validadas ✓':'Conta validada ✓','ok');
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');}
}
async function removerValidacao(amigo){
  if(!_sbSession||!DATA||!DATA._sbId)return;
  if(!confirm(`Anular a validação das contas de ${amigo}?`))return;
  setSync('load','a guardar…');
  try{
    await queueWrite(()=>sbReq('DELETE',`validacoes?evento_id=eq.${DATA._sbId}&amigo=eq.${enc(amigo)}`));
    VALIDACOES=VALIDACOES.filter(v=>!(v.evento_id===DATA._sbId&&v.amigo===amigo));
    marcaGuardado();renderAll();toast('Validação anulada','ok');
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');}
}

function secContasHtml(){
  if(!DATA)return'';
  const fechadas=contasFechadas();
  const admin=isAdmin();
  let s='';
  // ── Estado das Contas ──
  s+='<div class="sec-title sf" style="margin-top:26px">Estado das Contas</div>';
  s+='<div class="mlist">';
  s+=`<div class="contas-card ${fechadas?'fechada':'aberta'}">
        <div class="cc-row">
          <span class="cc-ic">${fechadas?'🔒':'🔓'}</span>
          <div class="cc-txt">
            <div class="cc-title">${fechadas?'Contas fechadas':'Contas abertas'}</div>
            <div class="cc-sub">${fechadas?('Fechadas a '+fmtDataHora(DATA.evento.contasFechadasEm)):'Ano editável — apuramento em curso'}</div>
          </div>
        </div>`;
  if(admin){
    if(fechadas){
      s+=`<button class="btn ghost sf" style="margin-top:13px" onclick="reabrirContas()">🔓 Reabrir Contas</button>`;
    } else if(podeFecharContas()){
      s+=`<button class="btn prim sf" style="margin-top:13px" onclick="fecharContas()">🔒 Fechar Contas</button>`;
    } else {
      const ult=ultimaRefeicaoISO();
      let motivo;
      if(!ult)motivo='Define primeiro as refeições do ano.';
      else if(hojeISO()<ult)motivo='Disponível a partir da última refeição ('+ult+').';
      else if(temDespesasPendentes())motivo='Há despesas previstas ainda sem data de pagamento.';
      else motivo='Indisponível de momento.';
      s+=`<button class="btn prim sf" style="margin-top:13px;opacity:.4;pointer-events:none">🔒 Fechar Contas</button>
          <p class="sf" style="font-size:11px;color:var(--faint);margin:8px 2px 0">${motivo}</p>`;
    }
  } else if(fechadas){
    s+=`<p class="sf" style="font-size:11px;color:var(--faint);margin:11px 2px 0">Este ano já não é editável.</p>`;
  }
  s+='</div>';

  // ── Validação de Contas (só com contas fechadas) ──
  if(fechadas){
    s+='<div class="sec-title sf" style="margin-top:22px">Validação de Contas</div>';
    const vals=validacoesDoAno();
    const podeValidar=temContasPorValidar();
    if(podeValidar){
      s+=`<button class="btn prim sf write-action" style="margin-bottom:12px;width:100%" onclick="abrirValModal()">✓ Validar contas</button>`;
    }
    const visiveis=admin?vals:vals.filter(v=>MY_NAMES.includes(v.amigo));
    s+='<div class="mlist">';
    if(!visiveis.length){
      s+='<div class="empty sf">'+(admin?'Ainda ninguém validou as contas deste ano.':(MY_NAMES.length?'Ainda não validaste as tuas contas.':'Liga a tua conta a um membro para poderes validar.'))+'</div>';
    } else {
      visiveis.slice().sort((a,b)=>(a.amigo||'').localeCompare(b.amigo||'','pt')).forEach(v=>{
        const podeAnular=admin||MY_NAMES.includes(v.amigo);
        const por=v.validado_por_amigo||'';
        const porDif=por&&por!==v.amigo;   // validado por outra pessoa (cônjuge/admin)
        let sub='Validado '+fmtDataHora(v.validado_em)+(por?' por '+por:'');
        s+=`<div class="val-row">
          <span class="val-ic">✓</span>
          <div class="val-txt"><div class="val-name">${v.amigo}</div><small>${sub}</small></div>
          ${podeAnular?`<button class="val-x write-action" onclick="removerValidacao('${(v.amigo||'').replace(/'/g,"\\'")}')" title="Anular validação">✕</button>`:''}
        </div>`;
      });
    }
    s+='</div>';
  }
  return s;
}
function marcaGuardado(){setSync('live','guardado · '+new Date().toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'}));}
function syncMirror(){if(ALL_YEARS[YEAR_IDX])ALL_YEARS[YEAR_IDX]=Object.assign(JSON.parse(JSON.stringify(DATA)),{_sbId:DATA._sbId});}
function queueWrite(fn){
  const p=_writeChain.then(fn);
  _writeChain=p.then(()=>true,()=>false);
  _writeBusy++;p.finally(()=>{_writeBusy--;});
  return p;
}

function changeYear(delta){
  const ni=YEAR_IDX+delta;
  if(ni<0||ni>=ALL_YEARS.length)return;
  YEAR_IDX=ni;
  selectYear();
}
function selectYear(){
  DATA=JSON.parse(JSON.stringify(ALL_YEARS[YEAR_IDX]));
  CALC=calcular(JSON.parse(JSON.stringify(DATA)));
  if(DATA.evento&&DATA.evento.ano)lsSet('fbv_ano',DATA.evento.ano);
  updateYearUI();
  renderAll();
}
function updateYearUI(){
  if(!ALL_YEARS.length)return;
  const ano=DATA.evento.ano||'—';
  document.getElementById('yr-label').textContent=ano;
  // Strip year from nome to avoid "MEO 2025 2025"
  let nomeLimpo=(DATA.evento.nome||'MEO').replace(/\s*\d{4}\s*/g,'').trim()||'MEO';
  document.getElementById('ev-nome').textContent=nomeLimpo;
  document.getElementById('yr-prev').disabled=YEAR_IDX<=0;
  document.getElementById('yr-next').disabled=YEAR_IDX>=ALL_YEARS.length-1;
}

/* MOTOR */
function rnd(x,n=2){const f=Math.pow(10,n);return Math.floor(Math.abs(x)*f+0.5)/f*(x>=0?1:-1);}
function roundup(x,n=0){const f=Math.pow(10,n);return Math.ceil(Math.abs(x)*f-1e-9)/f*(x>=0?1:-1);}
const sumv=o=>Object.values(o).reduce((a,b)=>a+b,0);

// A partir deste ano (inclusive), quem só bebe entra no denominador do indireto (alivia os
// que comem). Antes disso, mantém-se o modelo legado: quem só bebe herda o indireto/nº-que-comem
// como uma taxa que vai para o fundo (reproduz o antigo "Lanche").
const MODELO_BEBE_DESDE=2026;
// Presenças: cada item é {k:"dia|ref", modo:'come'|'bebe'}
function presIdx(m,key){return(m.presencas||[]).findIndex(p=>p&&p.k===key);}
function presModo(m,key){const p=(m.presencas||[]).find(p=>p&&p.k===key);return p?p.modo:null;}

// ── Fator das quotas: fixo (manual) ou variável (calculado pelas presenças) ──
const FATOR_THRESHOLD_DEFAULT=0.70;
function fmtFator(x){return Number(x||0).toLocaleString('pt-PT',{maximumFractionDigits:2});}
const CHECK_SVG='<svg class="ico-check" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8.4 12.4l2.5 2.5 4.7-5.3"/></svg>';
const SEX_M_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="14" r="5.2"/><line x1="14" y1="10" x2="20" y2="4"/><polyline points="15 4 20 4 20 9"/></svg>';
const SEX_F_SVG='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="9" r="5.2"/><line x1="12" y1="14.2" x2="12" y2="21"/><line x1="9" y1="18" x2="15" y2="18"/></svg>';
function _fatorPesoByKey(data){
  // peso de cada refeição, indexado pela chave de presença "dia|ref" (Lanche guarda-se como Tarde)
  const map={};
  for(const r of (data.refeicoesDef||[])){const k=r.dia+'|'+(r.ref==='Lanche'?'Tarde':r.ref);map[k]=(+r.peso||0);}
  return map;
}
function fatorVariavel(m,data){
  // score = soma dos pesos das refeições onde esteve (come OU bebe). Pesos somam 100%.
  const ev=data.evento||{};
  const thr=(ev.fatorThreshold!=null&&ev.fatorThreshold!=='')?+ev.fatorThreshold:FATOR_THRESHOLD_DEFAULT;
  const peso=_fatorPesoByKey(data);
  let score=0,cnt=0;
  (m.presencas||[]).forEach(p=>{if(!p||!p.k)return;score+=(peso[p.k]||0);cnt++;});
  const F=(m.sexo==='F');
  if(cnt===0)return 0;                 // nunca veio
  if(score>=thr)return F?0.25:1;       // >= limiar (peso) → fator máximo
  if(cnt>=2)return F?0.20:0.50;        // veio >1x mas abaixo do limiar
  return F?0.10:0.25;                  // veio só 1x
}
function fatorEfetivo(m,data){
  return (data&&data.evento&&data.evento.fatorModo==='variavel')?fatorVariavel(m,data):(+m.fator||0);
}

function calcular(data){
  aplicarStock(data);   // stock por refeição: move o alocado da bolsa comum p/ custos diretos (só na cópia)
  const{evento,membros,despesas,convidados,mealheiros,refeicoesDef,pagamentos}=data;
  const pag=pagamentos||[];
  const slotday={};for(const rd of refeicoesDef)slotday[rd.dia]=rd.data;
  const day2slot={};for(const k in slotday)day2slot[slotday[k]]=k;

  const tot={};for(const x of despesas)tot[x.tipo]=(tot[x.tipo]||0)+x.valor;
  const totalDesp=rnd(sumv(tot),2);

  // Almoço/Jantar são alocados diretamente à refeição via data-valor. As "previstas"
  // (sem data-valor) não casam com nenhuma refeição, por isso entram no rateio indireto (F20).
  const allocDireta=despesas.filter(x=>(x.tipo==='Almoço'||x.tipo==='Jantar')&&x.dataValor).reduce((a,x)=>a+x.valor,0);
  const F20=rnd((totalDesp-allocDireta)*0.5,2);

  // Repartição do indireto entre "bebidas", "cerveja" e "gerais" (só apresentação na lista).
  // A bolsa indireta = tudo o que não é despesa direta de refeição. A soma das 3 parcelas é
  // SEMPRE igual ao indireto I, por isso L/P/Q e os saldos não mudam.
  const baseIndireta=rnd(totalDesp-allocDireta,2);
  const baseBebidas=rnd(despesas.filter(x=>x.tipo==='Bebidas').reduce((a,x)=>a+x.valor,0),2);
  const baseCerveja=rnd(despesas.filter(x=>x.tipo==='Cerveja').reduce((a,x)=>a+x.valor,0),2);
  const fracBebidas=baseIndireta>0?baseBebidas/baseIndireta:0;
  const fracCerveja=baseIndireta>0?baseCerveja/baseIndireta:0;

  const slotKeyOf=(d,ref)=>{const rs=ref==='Lanche'?'Tarde':ref;return day2slot[d]+'|'+rs;};
  const countModo=(d,ref,modo)=>{const s=slotKeyOf(d,ref);return membros.filter(m=>(m.presencas||[]).some(p=>p.k===s&&p.modo===modo)).length;};
  const countAny=(d,ref)=>{const s=slotKeyOf(d,ref);return membros.filter(m=>(m.presencas||[]).some(p=>p.k===s)).length;};
  const indiretoComBebe=(evento.ano||9999)>=MODELO_BEBE_DESDE;

  const refeicoes=[];let prevIndirectPerPerson=0;
  for(const rd of refeicoesDef){
    const Ec=convidados.filter(g=>g.dia===rd.dia&&g.ref===rd.ref&&g.pagante==='Sim').length;
    if(rd.ref==='Lanche'){
      // LEGADO: lanche herda o indireto unitário do almoço anterior (taxa para o fundo).
      // Mantido para anos antigos não migrados ao modelo "só bebe".
      const D=countAny(rd.data,rd.ref)+Ec;
      const L=rnd(prevIndirectPerPerson,2);
      const P=D===0?0:Math.max(rd.minMEO,L);
      let Q;
      if(Ec===0)Q=0;else Q=P===0?0:Math.max(5,roundup(P,0)+rd.extraConv);
      const indir=rnd(L*D,2);
      const cBebidas=rnd(indir*fracBebidas,2),cCerveja=rnd(indir*fracCerveja,2),cGerais=rnd(indir-cBebidas-cCerveja,2);
      refeicoes.push({...rd,D,E:Ec,Ncomem:D,Nbebe:0,Fdir:0,I:0,L,P,Pbebe:0,Q,dirRef:0,cBebidas,cCerveja,cGerais,custoTotal:indir,custoUnit:L,custoUnitBebe:0,temBebe:false});
      continue;
    }
    // Refeição normal (Almoço/Jantar): estados come / só bebe
    const Ncomem=countModo(rd.data,rd.ref,'come')+Ec;   // convidados comem sempre
    const Nbebe=countModo(rd.data,rd.ref,'bebe');
    const Fdir=despesas.filter(x=>x.tipo===rd.ref&&x.dataValor===rd.data).reduce((a,x)=>a+x.valor,0);
    const I=rnd(F20*(rd.peso||0),2);
    const Ndiv=indiretoComBebe?(Ncomem+Nbebe):Ncomem;   // 2026+: bebes entram no denominador
    const indiretoPP=Ndiv>0?rnd(I/Ndiv,2):0;
    const diretoPP=Ncomem>0?rnd(Fdir/Ncomem,2):0;
    const L=rnd(diretoPP+indiretoPP,2);                  // unitário de quem come
    const Lbebe=indiretoPP;                              // unitário de quem só bebe
    if(Ncomem)prevIndirectPerPerson=rnd(I/Ncomem,2);     // para o lanche legado herdar
    const P=Ncomem===0?0:Math.max(rd.minMEO,L);
    const Pbebe=Lbebe;                                   // sem mínimo
    let Q;
    if(Ec===0)Q=0;else Q=P===0?0:Math.max(rd.minConv,roundup(P,0)+rd.extraConv);
    const dirRef=rnd(Fdir,2);
    const cBebidas=rnd(I*fracBebidas,2),cCerveja=rnd(I*fracCerveja,2),cGerais=rnd(I-cBebidas-cCerveja,2);
    const custoTotal=rnd(Fdir+I,2);
    refeicoes.push({...rd,D:Ncomem,E:Ec,Ncomem,Nbebe,Fdir:rnd(Fdir,2),I,L,P,Pbebe,Q,dirRef,cBebidas,cCerveja,cGerais,custoTotal,custoUnit:L,custoUnitBebe:Lbebe,temBebe:Nbebe>0});
  }

  const rmap={};for(const r of refeicoes)rmap[r.data+'|'+r.ref]=r;
  const reffor=(dia,ref)=>{if(ref==='Tarde')ref='Lanche';return rmap[slotday[dia]+'|'+ref];};
  for(const m of membros){
    m._refs=[];
    (m.presencas||[]).forEach(p=>{
      const[dia,ref]=p.k.split('|');
      const r=reffor(dia,ref);
      if(!r)return;
      const refName=ref==='Tarde'?'Lanche':ref;
      if(p.modo==='bebe'){
        if(r.Pbebe>0)m._refs.push({dia,ref:refName,p:r.Pbebe,modo:'bebe'});
      } else {
        if(r.P>0)m._refs.push({dia,ref:refName,p:r.P,modo:'come'});
      }
    });
    m.Sown=rnd(m._refs.reduce((a,x)=>a+x.p,0),2);
    m._convs=convidados.filter(g=>g.membro===m.nome&&g.pagante==='Sim').map(g=>{
      const r=reffor(g.dia,g.ref);
      return{nome:g.nome,dia:g.dia,ref:g.ref,q:r?r.Q:0};
    });
    m.AA=rnd(m._convs.reduce((a,x)=>a+x.q,0),2);
  }

  const totRefMembros=rnd(membros.reduce((a,m)=>a+m.Sown,0),2);
  const totGuestPayments=rnd(membros.reduce((a,m)=>a+m.AA,0),2);
  const sobrasTot=0; // migrado para mealheiros
  const descontoTot=0; // migrado para mealheiros
  const mealTot=mealheiros.reduce((a,x)=>a+x.valor,0);

  const baseQuota=totalDesp-(totRefMembros+totGuestPayments+sobrasTot+descontoTot+mealTot);
  const fundoReserva=evento.fundoReserva||0;
  const missaoPoupanca=evento.missaoPoupanca||0;
  const arredondaTotal=evento.arredondaTotal!==undefined?evento.arredondaTotal:false;
  const BN3=baseQuota<=0?0:rnd(baseQuota+fundoReserva,2);
  const sumF=membros.reduce((a,m)=>{m.fatorEf=fatorEfetivo(m,data);return a+m.fatorEf;},0);

  const mealBy={};for(const x of mealheiros)mealBy[x.quem]=(mealBy[x.quem]||0)+x.valor;

  // Contribuições/poupança extra registadas em pagamentos de dívida (Opção B):
  // o p.extra está incluído no p.valor; aqui acresce-se à poupança de quem pagou,
  // por cima das "outras" históricas do membro. Reembolsos nunca têm extra.
  const extraBy={};
  for(const p of pag){
    if(!p||!p.de)continue;
    if(p.ref&&p.ref.startsWith('Reembolso'))continue;
    const e=+p.extra||0;
    if(e>0)extraBy[p.de]=rnd((extraBy[p.de]||0)+e,2);
  }

  for(const m of membros){
    m.R=sumF>0?Math.max(rnd(BN3*(m.fatorEf!=null?m.fatorEf:m.fator)/sumF,2),0):0;
    // poupança extra agora vem só dos pagamentos (campo legado membros.outras removido)
    m.T=rnd(extraBy[m.nome]||0,2);
    if(arredondaTotal){
      m.U=rnd(roundup(m.Sown+m.R,0)-m.R-m.Sown+missaoPoupanca+m.T,2);
    } else {
      m.U=rnd(missaoPoupanca+m.T,2);
    }
    m.V=rnd(m.Sown+m.R+m.U,2);
    m.W=mealBy[m.nome]||0;
    m.X=0; // sobras e outros migrados para mealheiros
    const totalPago=despesas.filter(x=>x.quem===m.nome).reduce((a,x)=>a+x.valor,0);
    const reembolsadas=pag.filter(p=>p.ref&&p.ref.startsWith('Reembolso')&&p.para===m.nome).reduce((a,p)=>a+p.valor,0);
    const recebeuReemb=pag.filter(p=>p.ref&&p.ref.startsWith('Reembolso')&&p.de===m.nome).reduce((a,p)=>a+p.valor,0);
    m.Y=rnd(totalPago-reembolsadas+recebeuReemb,2);
    m._pago=m.Y;
    m.Z=rnd(m.Y+m.W+m.X-m.V,2);
  }

  const missaoTot=rnd(membros.reduce((a,m)=>a+m.U,0),2);
  const quotaTot=rnd(membros.reduce((a,m)=>a+m.R,0),2);
  const totRefAll=rnd(membros.reduce((a,m)=>a+m.Sown,0),2);
  const totReceitas=rnd(quotaTot+totRefAll+totGuestPayments+sobrasTot+descontoTot+mealTot+missaoTot,2);
  const saldoGrupo=rnd(totReceitas-totalDesp,2);

  const pagNonReemb=pag.filter(p=>!p.ref||!p.ref.startsWith('Reembolso'));
  const nomes=membros.map(m=>m.nome);
  for(const m of membros){
    m.AB=m.nome===evento.tesoureiro?saldoGrupo:0;
    m.AC=rnd(m.Z-m.AA+m.AB,2);
  }

  const mByName={};for(const m of membros)mByName[m.nome]=m;
  const credited={};
  const creditedConv={};
  const creditedBy={};  // creditedBy[nome] = [{payer, amount, type:'own'|'conv'}]
  const payerOwnPortion={};  // payerOwnPortion[payerName] = total allocated to payer's own debts (own + conv)
  const payerOthersPortion={};  // payerOthersPortion[payerName] = total allocated to other people's debts
  for(const p of pagNonReemb){
    if(!p.ref){
      const m=mByName[p.de];if(m&&m.AC<0){credited[p.de]=(credited[p.de]||0)+p.valor;payerOwnPortion[p.de]=(payerOwnPortion[p.de]||0)+p.valor;}
      continue;
    }
    const parts=p.ref.split(/,\s*/).map(x=>x.trim()).filter(Boolean);
    const isNew=parts.some(x=>x.startsWith('own:')||x.startsWith('conv:'));
    if(isNew){
      let totalItems=0;
      const items=[];
      parts.forEach(pt=>{
        if(pt.startsWith('own:')){
          const nome=pt.slice(4);const m=mByName[nome];
          if(m){const v=rnd(m.V-m.Y-m.W-m.X,2);items.push({type:'own',nome,v});totalItems+=v;}
        } else if(pt.startsWith('conv:')){
          const nome=pt.slice(5);const m=mByName[nome];
          if(m){const v=Math.max(0,m.AA);items.push({type:'conv',nome,v});totalItems+=v;}
        }
      });
      items.forEach(it=>{
        const alloc=totalItems>0?rnd(p.valor*it.v/totalItems,2):rnd(p.valor/items.length,2);
        if(it.type==='own')credited[it.nome]=(credited[it.nome]||0)+alloc;
        else creditedConv[it.nome]=(creditedConv[it.nome]||0)+alloc;
        // Track who paid for whom
        if(!creditedBy[it.nome])creditedBy[it.nome]=[];
        creditedBy[it.nome].push({payer:p.de,amount:alloc,type:it.type});
        // Track payer's own vs others portion
        if(it.nome===p.de||(it.type==='conv'&&it.nome===p.de)){
          payerOwnPortion[p.de]=(payerOwnPortion[p.de]||0)+alloc;
        } else {
          payerOthersPortion[p.de]=(payerOthersPortion[p.de]||0)+alloc;
        }
      });
    } else {
      const covNames=parts.filter(x=>nomes.includes(x));
      if(!covNames.length){const m=mByName[p.de];if(m&&m.AC<0)credited[p.de]=(credited[p.de]||0)+p.valor;continue;}
      const totalDebtCov=covNames.reduce((a,cn)=>{const mm=mByName[cn];return a+(mm&&mm.AC<0?Math.abs(mm.AC):0);},0);
      covNames.forEach(cn=>{
        const mm=mByName[cn];if(!mm)return;
        let alloc;
        if(totalDebtCov>0&&mm.AC<0)alloc=rnd(p.valor*Math.abs(mm.AC)/totalDebtCov,2);
        else if(covNames.length===1)alloc=p.valor;
        else alloc=rnd(p.valor/covNames.length,2);
        credited[cn]=(credited[cn]||0)+alloc;
      });
    }
  }
  const tes=evento.tesoureiro;
  const recvTes=pagNonReemb.filter(p=>p.para===tes).reduce((a,p)=>a+p.valor,0);
  // Total credits already distributed to other members (these reduce their debts,
  // so they must also reduce the tesoureiro's receivable to avoid double-counting)
  const totalCredited=rnd(Object.values(credited).reduce((a,v)=>a+v,0)+Object.values(creditedConv).reduce((a,v)=>a+v,0),2);
  for(const m of membros){
    if(m.nome===tes){
      m.saldoFinal=rnd(m.AC+recvTes-totalCredited,2);
    } else {
      const ownCredit=credited[m.nome]||0;
      const convCredit=creditedConv[m.nome]||0;
      m.saldoFinal=rnd(m.AC+ownCredit+convCredit,2);
      if(Math.abs(m.saldoFinal)<0.02)m.saldoFinal=0;
    }
    m._pagouTotal=rnd(pagNonReemb.filter(p=>p.de===m.nome).reduce((a,p)=>a+p.valor,0),2);
    m._recebeuTotal=rnd(pagNonReemb.filter(p=>p.para===m.nome).reduce((a,p)=>a+p.valor,0),2);
    m._pagamentos=pagNonReemb.filter(p=>p.de===m.nome||p.para===m.nome);
    m._ownCredit=credited[m.nome]||0;
    m._convCredit=creditedConv[m.nome]||0;
    m._creditedBy=creditedBy[m.nome]||[];
    m._payerOwnPortion=payerOwnPortion[m.nome]||0;
    m._payerOthersPortion=payerOthersPortion[m.nome]||0;
  }

  return{refeicoes,membros,BN3,F20,saldoGrupo,totRefMembros,tot,totReceitas,totDespesas:totalDesp,sumF,pagamentos:pag,sobrasTot,descontoTot,mealTot,quotaTot,missaoTot};
}

/* RENDER */
const eur=x=>new Intl.NumberFormat('pt-PT',{style:'currency',currency:'EUR'}).format(x);
// Ícone "só bebe" — caneca de cerveja com espuma, uma cor (currentColor)
const BEER_SVG='<svg class="beer-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 11h1a3 3 0 0 1 0 6h-1"/><path d="M9 12v6"/><path d="M13 12v6"/><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 3 11 3s2 .5 3 .5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"/><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/></svg>';
const BEER_SVG_SM='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex:none"><path d="M17 11h1a3 3 0 0 1 0 6h-1"/><path d="M9 12v6"/><path d="M13 12v6"/><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 3 11 3s2 .5 3 .5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"/><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/></svg>';
// ── Ícones de refeição (Lucide-style, cor via classe .mi-*) ──
const MEAL_SUN='<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>';
const MEAL_MOON='<path d="M18 5h3"/><path d="M19.5 3.5v3"/><path d="M21 13a8 8 0 1 1-9.5-9.8A6 6 0 0 0 21 13Z"/>';
const MEAL_COFFEE='<path d="M10 2v2"/><path d="M14 2v2"/><path d="M6 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/>';
function mealIco(ref,px){
  px=px||18;
  const r=(ref||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  let key,title,body;
  if(r.startsWith('alm')){key='almoco';title='Almoço';body=MEAL_SUN;}
  else if(r.startsWith('jan')){key='jantar';title='Jantar';body=MEAL_MOON;}
  else if(r.startsWith('lan')||r.startsWith('tar')){key='lanche';title='Lanche';body=MEAL_COFFEE;}
  else {key='lanche';title=ref||'Refeição';body=MEAL_COFFEE;}
  return `<svg class="meal-ic mi-${key}" width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>`;
}
const AVCOL=['#eeb64d','#e0533f','#2f9e77','#7fa8c9','#d98a3d','#43c98a','#c96f8a','#b98cff'];
function av(nome,i){return`<div class="av" style="background:${AVCOL[i%AVCOL.length]}">${nome.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase()}</div>`;}

function setTab(t){if(t==='stock'&&(!STOCK_TABLE||contasFechadas()))t='compras';if(t==='compras'&&contasFechadas())t='saldos';TAB=t;document.querySelectorAll('.tab').forEach(e=>e.classList.toggle('on',e.dataset.tab===t));
  if(['saldos','refeicoes','cashflows','compras','stock'].includes(t))lsSet('fbv_tab',t);
  ['saldos','refeicoes','cashflows','compras','stock'].forEach(v=>{const el=document.getElementById('view-'+v);if(el)el.style.display=v===t?'':'none';});
  // Hero only visible in saldos tab
  const hero=document.getElementById('hero-card');
  if(hero)hero.style.display=t==='saldos'?'':'none';
  if(t==='compras')renderCompras();
  if(t==='stock')renderStock();
  updateStockTabVis();
  updateGuestFab();
}

let REF_SUB='calendario';
function setRefSub(s){REF_SUB=s;lsSet('fbv_refsub',s);document.querySelectorAll('.sub-tab').forEach(e=>e.classList.toggle('on',e.dataset.sub===s));
  document.getElementById('ref-sub-calendario').style.display=s==='calendario'?'':'none';
  document.getElementById('ref-sub-presencas').style.display=s==='presencas'?'':'none';
  const cv=document.getElementById('ref-sub-convidados');if(cv)cv.style.display=s==='convidados'?'':'none';
  updateGuestFab();}
// Mesmas regras do antigo botão "+ Adicionar Convidado"
function guestAddAllowed(){
  if(!DATA||!DATA.refeicoesDef||!DATA.refeicoesDef.length)return false;
  if(document.body.classList.contains('read-only'))return false;
  if(document.body.classList.contains('contas-fechadas'))return false;
  if(!isAdmin()){
    if(!MY_NAMES.length)return false;
    if(!(DATA.refeicoesDef||[]).some(rd=>rd.data>=hojeISO()))return false;
  }
  return true;
}
// FAB de convidado: só visível na aba Refeições › sub-aba Convidados (e se for permitido)
function updateFabs(){
  const guest=document.getElementById('fab-guest');
  const cash=document.getElementById('fab-cash');
  const handle=document.getElementById('fab-drag');
  let anyVisible=false;
  // Convidado: só na aba Refeições › Convidados (e se permitido)
  if(guest){
    const show=(TAB==='refeicoes'&&REF_SUB==='convidados'&&guestAddAllowed());
    guest.style.display=show?'':'none';
    if(show)anyVisible=true;
  }
  // Cash-flow: só na aba Cash-Flows (regras de fecho/saldado continuam a esconder via CSS !important)
  if(cash){
    const show=(TAB==='cashflows');
    cash.style.display=show?'':'none';
    if(show&&getComputedStyle(cash).display!=='none')anyVisible=true;
  }
  // Handle de arrastar: só faz sentido se houver pelo menos um FAB à vista
  if(handle)handle.style.display=anyVisible?'':'none';
}
// Alias retrocompatível
function updateGuestFab(){updateFabs();}
let REF_SEL=0;
function setRefMeal(i){REF_SEL=i;lsSet('fbv_refmeal',String(i));
  document.querySelectorAll('.refnav-chip').forEach(e=>e.classList.toggle('on',+e.dataset.i===i));
  document.querySelectorAll('.refmeal').forEach(e=>{e.style.display=(+e.dataset.i===i?'':'none');});}
function togglePeople(id){const e=document.getElementById(id);if(!e)return;const show=(e.style.display==='none'||!e.style.display);e.style.display=show?'flex':'none';const c=document.querySelector('[data-tgt="'+id+'"]');if(c)c.classList.toggle('open',show);}

/* Detalhe "quem vai" agrupado por agregado (casal): os membros que comem numa
   linha ("Diogo / Margarida") e os convidados desse agregado por baixo, em tom
   apagado. Convidados de quem não come aparecem num grupo próprio. */
function casaisPanelHtml(membrosCome,guests){
  const key=n=>{const c=conjugeDe(n);return c?[n,c].sort((a,b)=>a.localeCompare(b,'pt')).join('|'):n;};
  const hh={};
  const get=k=>hh[k]||(hh[k]={nomes:[],convs:[]});
  membrosCome.forEach(n=>get(key(n)).nomes.push(n));
  guests.forEach(g=>get(g.membro?key(g.membro):'?').convs.push(g));
  return Object.keys(hh).sort((a,b)=>a.localeCompare(b,'pt')).map(k=>{
    const h=hh[k];
    h.convs.sort((a,b)=>a.nome.localeCompare(b.nome,'pt'));
    const head=h.nomes.length
      ?h.nomes.join(' / ')
      :'convidados de '+[...new Set(h.convs.map(g=>g.membro||'?'))].join(' / ');
    const convs=h.convs.length?`<div class="rdc-casal-conv">🎟 ${h.convs.map(g=>escHtml(g.nome)+(g.pagante==='Sim'?'':' <small>(não paga)</small>')).join(', ')}</div>`:'';
    return `<div class="rdc-casal"><div class="rdc-casal-n${h.nomes.length?'':' off'}">${escHtml(head)}</div>${convs}</div>`;
  }).join('');
}

/* ── Classify a cash-flow entry ── */
function cfType(p){
  if(p._cfType) return p._cfType; // explicitly set
  if(p.ref && p.ref.startsWith('Reembolso')) return 'reembolso';
  if(p.ref && (p.ref.includes('own:') || p.ref.includes('conv:'))) return 'saldar';
  // generic payment without ref — now treated as saldar
  const tes=DATA.evento.tesoureiro;
  if(p.de===tes) return 'reembolso';
  return 'saldar';
}
function cfLabel(t){
  return{reembolso:'Reembolso',despesa:'Despesa',mealheiro:'Mealheiro',saldar:'Pagar Dívida'}[t]||t;
}
function cfIcon(t){
  return{reembolso:'💸',despesa:'🛒',mealheiro:'🐷',saldar:'🤝'}[t]||'💰';
}
// Lata de recolha vermelha: tampa metálica com ranhura de moedas + cinta com €
// (não há emoji de lata simples — o 🥫 parece polpa de tomate)
const ICON_LATA='<svg viewBox="0 0 24 24" width="1em" height="1em" style="vertical-align:-.125em" aria-hidden="true"><path d="M5 5v14c0 1.66 3.13 3 7 3s7-1.34 7-3V5z" fill="#e03131"/><path d="M5 10.2c0 1.66 3.13 3 7 3s7-1.34 7-3v4.6c0 1.66-3.13 3-7 3s-7-1.34-7-3z" fill="#fbf6e8"/><text x="12" y="17.2" text-anchor="middle" font-size="5" font-weight="800" fill="#c92a2a" font-family="system-ui,sans-serif">€</text><ellipse cx="12" cy="5" rx="7" ry="2.6" fill="#b8b0a1"/><ellipse cx="12" cy="4.8" rx="5.7" ry="2" fill="#ddd5c6"/><rect x="8.7" y="4" width="6.6" height="1.5" rx=".75" fill="#3f362b"/></svg>';
// Saco de dinheiro (Sobras Ano Anterior) e moeda (Outros) — mesmo estilo da Lata
const ICON_SACO='<svg viewBox="0 0 24 24" width="1em" height="1em" style="vertical-align:-.125em" aria-hidden="true"><path d="M9 2.5h6c.5 0 .7.5.4.9L13.8 5.5h-3.6L8.6 3.4c-.3-.4-.1-.9.4-.9z" fill="#8a6410"/><path d="M10.2 5.5h3.6c3.7 1.9 6 5.5 6 9.3 0 4.4-3.2 6.7-7.8 6.7s-7.8-2.3-7.8-6.7c0-3.8 2.3-7.4 6-9.3z" fill="#eeb64d"/><path d="M9.4 6.7c-.4-.5-.1-1.2.6-1.2h4c.7 0 1 .7.6 1.2l-.6.7h-4z" fill="#c8951f"/><text x="12" y="17.4" text-anchor="middle" font-size="9.5" font-weight="800" fill="#7a5a0e" font-family="system-ui,sans-serif">€</text></svg>';
const ICON_MOEDA='<svg viewBox="0 0 24 24" width="1em" height="1em" style="vertical-align:-.125em" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="#c8951f"/><circle cx="12" cy="12" r="7.7" fill="#eeb64d"/><circle cx="12" cy="12" r="6.3" fill="none" stroke="#a87b14" stroke-width=".9" stroke-dasharray="1.7 1.7"/><text x="12" y="15.6" text-anchor="middle" font-size="10" font-weight="800" fill="#7a5a0e" font-family="system-ui,sans-serif">€</text></svg>';

function renderAll(){
  if(!CALC)return;const ms=CALC.membros;
  let nomeLimpo=(DATA.evento.nome||'MEO').replace(/\s*\d{4}\s*/g,'').trim()||'MEO';
  document.getElementById('ev-nome').textContent=nomeLimpo;
  document.getElementById('ev-sub').textContent=DATA.evento.datas||DATA.evento.local||'';
  const sg=CALC.saldoGrupo;const sgEl=document.getElementById('saldo-grupo');
  sgEl.textContent=eur(sg);sgEl.className='big '+(sg>=0?'pos':'neg');
  document.getElementById('tot-rec').textContent=eur(CALC.totReceitas);
  document.getElementById('tot-desp').textContent=eur(CALC.totDespesas);

  // Hero only visible in saldos tab
  const hero=document.getElementById('hero-card');
  if(hero)hero.style.display=TAB==='saldos'?'':'none';

  // Render expandable sub-totals
  renderHeroSubtotals();

  // Read-only mode
  updateReadOnlyMode();

  // SALDOS — usar cálculo consistente com o ecrã de detalhe
  const pAll=CALC.pagamentos;
  const pNR=pAll.filter(p=>!p.ref||!p.ref.startsWith('Reembolso'));
  const _mvLi=(d,txt,v)=>({k:(d?fmtDiaMes(d)+' — ':'')+txt,v:rnd(v,2)});
  ms.forEach(m=>{
    const isTes=m.nome===DATA.evento.tesoureiro;
    const despL=DATA.despesas.filter(x=>x.quem===m.nome);
    const totalPagoDesp=despL.reduce((a,x)=>a+x.valor,0);
    const rfL=pAll.filter(p=>p.ref&&p.ref.startsWith('Reembolso')&&p.de===m.nome);
    const reembFeitos=rfL.reduce((a,p)=>a+p.valor,0);
    const rrL=pAll.filter(p=>p.ref&&p.ref.startsWith('Reembolso')&&p.para===m.nome);
    const reembRecebidos=rrL.reduce((a,p)=>a+p.valor,0);
    const rcL=pNR.filter(p=>p.para===m.nome);
    const receb=rcL.reduce((a,p)=>a+p.valor,0);
    const mealL=DATA.mealheiros.filter(x=>x.quem===m.nome);
    const mealT=rnd((m.W||0)+(m.X||0),2);
    const contribT=rnd(m.Sown+m.AA,2);
    const quotaE=rnd((m.R||0)+(m.U||0),2);
    let cred=totalPagoDesp;
    if(isTes) cred+=reembFeitos;
    if(!isTes){cred+=rnd(m._payerOwnPortion,2);(m._creditedBy||[]).filter(c=>c.payer!==m.nome).forEach(c=>{cred+=c.amount;});}
    cred=rnd(cred,2);
    const deb=rnd(contribT+quotaE+mealT+receb+reembRecebidos,2);
    const paidBy={};
    if(!isTes)(m._creditedBy||[]).filter(c=>c.payer!==m.nome).forEach(c=>{paidBy[c.payer]=rnd((paidBy[c.payer]||0)+c.amount,2);});
    m._mv={isTes,
      pagoDesp:rnd(totalPagoDesp,2),pagoDespL:despL.map(x=>_mvLi(x.dataDesp,x.desc||x.tipo||'despesa',x.valor)),
      reembFeitos:rnd(reembFeitos,2),reembFeitosL:rfL.map(p=>_mvLi(p.data,'para '+p.para,p.valor)),
      reembRecebidos:rnd(reembRecebidos,2),reembRecebidosL:rrL.map(p=>_mvLi(p.data,'de '+p.de,p.valor)),
      receb:rnd(receb,2),recebL:rcL.map(p=>_mvLi(p.data,'de '+p.de,p.valor)),
      mealT,mealL:mealL.map(x=>_mvLi(x.data,x.desc||x.subtipo||'mealheiro',x.valor)),
      ownPortion:isTes?0:rnd(m._payerOwnPortion,2),paidBy};
    m._sfEcra=rnd(cred-deb,2);
  });
  // Lista fundida (antigo Resumo + saldo individual): despesa por membro, movimentos e saldo
  let h=saldosMembrosHtml();

  // CONTAS — fecho de contas + validação (depois do saldo global)
  h+=secContasHtml();

  // RELATÓRIOS — links movidos do antigo tab para o fundo dos Saldos
  h+=`<div class="sec-title sf" style="margin-top:24px">Relatórios</div>
  <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:6px">
    <button class="btn prim sf" onclick="generatePDF('geral')" style="display:flex;align-items:center;justify-content:center;gap:8px;padding:14px">
      📄 Relatório Geral
    </button>
    <p class="sf" style="font-size:11px;color:var(--faint);margin-top:-4px">Saldos de todos os membros, cash-flows, receitas e despesas.</p>
    <div style="margin-top:6px">
      <label class="sf" style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);font-weight:700;margin-bottom:6px;display:block">Relatório por Pessoa</label>
      <div style="display:flex;gap:8px">
        <select id="report-person" class="sf" style="flex:1;min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 12px;color:var(--ink);font-size:14px;font-family:inherit;-webkit-appearance:none;appearance:none">
          ${ms.map(m=>`<option value="${m.nome}">${m.nome}</option>`).join('')}
        </select>
        <button class="btn prim sf" onclick="generatePDF('pessoa')" style="flex:0 0 auto;padding:10px 18px">📄 Gerar</button>
      </div>
      <p class="sf" style="font-size:11px;color:var(--faint);margin-top:6px">Detalhe completo: contribuições, pagamentos, saldo final.</p>
    </div>
  </div>`;

  document.getElementById('view-saldos').innerHTML=h;
  updateContasUI();

  // REFEIÇÕES — sub-tabbed: Calendário + Presenças
  let r='';
  r+='<div class="sub-tabs sf"><div class="sub-tab'+(REF_SUB==='calendario'?' on':'')+'" data-sub="calendario" onclick="setRefSub(\'calendario\')">📅 Calendário</div><div class="sub-tab'+(REF_SUB==='presencas'?' on':'')+'" data-sub="presencas" onclick="setRefSub(\'presencas\')">✋ Presenças</div><div class="sub-tab'+(REF_SUB==='convidados'?' on':'')+'" data-sub="convidados" onclick="setRefSub(\'convidados\')">👥 Convidados</div></div>';

  // ── Alerta admin: peso das refeições tem de somar 100% ──
  if(isAdmin()&&DATA.refeicoesDef&&DATA.refeicoesDef.length){
    const somaPeso=DATA.refeicoesDef.reduce((a,rd)=>a+(rd.peso!=null?(+rd.peso||0):0),0);
    if(Math.abs(somaPeso-1)>0.0001){
      const pct=Number((somaPeso*100).toFixed(2)).toLocaleString('pt-PT',{maximumFractionDigits:2});
      const dif=Number(((somaPeso-1)*100).toFixed(2));
      const difTxt=(dif>0?'+':'')+dif.toLocaleString('pt-PT',{maximumFractionDigits:2});
      r+=`<div style="background:rgba(224,83,63,.10);border:1px solid rgba(224,83,63,.42);color:#9c3a2c;border-radius:10px;padding:10px 14px;margin:0 0 12px;font-size:12.5px;line-height:1.45;font-weight:600">⚠️ O peso das refeições soma <b>${pct}%</b> (${difTxt} p.p.) — devia somar <b>100%</b>. Ajusta os pesos, senão a bolsa indireta e os fatores variáveis ficam errados.</div>`;
    }
  }

  // ── SUB 1: Calendário (merged: definição + custo por pessoa) ──
  r+='<div id="ref-sub-calendario" style="'+(REF_SUB==='calendario'?'':'display:none')+'">';
  if(!DATA.refeicoesDef||!DATA.refeicoesDef.length){
    r+='<div class="refdef-empty sf">Nenhuma refeição definida para este ano.<br>Adiciona dias e refeições para começar.</div>';
  } else {
    const icoOf=(ref,px=17)=>mealIco(ref,px);
    const meals=DATA.refeicoesDef.map((rd,i)=>({...rd,_idx:i}));
    let sel=REF_SEL;if(sel<0||sel>=meals.length)sel=0;REF_SEL=sel;
    // Barra de navegação horizontal — um chip por refeição (dá a volta, sem scroll lateral)
    r+='<div class="refnav sf">'+meals.map(m=>`<button class="refnav-chip${m._idx===sel?' on':''}" data-i="${m._idx}" onclick="setRefMeal(${m._idx})"><span class="rn-ico">${icoOf(m.ref)}</span><span class="rn-txt"><span class="rn-day">${m.dia}</span><span class="rn-ref">${m.ref}</span></span></button>`).join('')+'</div>';
    r+='<div class="refdef-cards">';
    meals.forEach(rd=>{
      const icon=icoOf(rd.ref);
      const calcRef=CALC.refeicoes.find(x=>x.data===rd.data&&x.ref===rd.ref);
      const pesoDisplay=rd.peso!=null?(Number(((rd.peso||0)*100).toFixed(2)).toLocaleString('pt-PT',{maximumFractionDigits:2})+'%'):'—';
      // Três sub-cards: custos indiretos · custos diretos · custo da refeição
      let costCards='';
      if(calcRef){
        const indTot=calcRef.I||0;
        const dirTot=calcRef.dirRef||0;
        let indPP=calcRef.custoUnitBebe||0;
        if(indPP===0&&indTot>0&&calcRef.D>0)indPP=rnd(indTot/calcRef.D,2);
        let dirPP=dirTot>0?rnd((calcRef.custoUnit||0)-(calcRef.custoUnitBebe||0),2):0;
        if(dirPP<0)dirPP=0;
        // Custo por pessoa discreto no cabeçalho (slot de largura fixa p/ alinhar os 3 cards;
        // sem espaço antes do € para ficar mais curto)
        const ppTag=v=>`<span class="rdc-pp">${calcRef.D>0?eur(v).replace(/\s*€/,'€')+' p.p.':''}</span>`;
        const ind=[
          {c:'b',lbl:'Bebidas',v:calcRef.cBebidas},
          {c:'cv',lbl:'Cerveja',v:calcRef.cCerveja},
          {c:'g',lbl:'Gerais',v:calcRef.cGerais}
        ].filter(x=>x.v>0);
        const chipsHtml=ind.map(x=>`<span class="rc ${x.c}">${x.lbl} ${eur(x.v)}</span>`).join('');
        const pesoHtml=rd.peso!=null?`<div class="rdc-peso"><span class="rdc-peso-lbl">Peso <b>${pesoDisplay}</b></span><span class="rdc-peso-rule"></span></div>`:'';
        const notaBebe=calcRef.temBebe?' <span class="rdc-note">= custo p/ quem só bebe</span>':'';
        // Colapsados por defeito (só label + total); toque expande o detalhe
        costCards+=`<details class="rdc rdc-fold sf" onclick="event.stopPropagation()">
          <summary class="rdc-hdr"><span class="rdc-lbl">Custos indiretos</span><span class="rdc-tot">${eur(indTot)}</span>${ppTag(indPP)}<span class="rdc-fold-arrow">›</span></summary>
          ${pesoHtml}${chipsHtml?`<div class="rdc-chips">${chipsHtml}</div>`:''}
          <div class="rdc-unit"><span>Por pessoa${notaBebe}</span><span class="rdc-unit-v">${eur(indPP)}</span></div>
        </details>`;
        const dirItems=(DATA.despesas||[]).filter(x=>x.tipo===rd.ref&&x.dataValor===rd.data).slice();
        // Alocações de stock a esta refeição contam como custo direto — entram no detalhe
        stockArr().forEach(l=>{if(!stockBacked(l)||!(l.qtd>0))return;(l.alocacoes||[]).forEach(a=>{if(a.tipo===rd.ref&&a.data===rd.data&&+a.qtd>0)dirItems.push({desc:'🧺 '+l.artigo+' ('+fmtQty(+a.qtd,l.unidade)+')',quem:'',valor:rnd(l.valor/l.qtd*a.qtd,2)});});});
        const dirDetBody=dirItems.length?`<div class="rdc-det-body">${dirItems.map(it=>`<div class="rdc-det-it"><span class="k">${escHtml(it.desc||'(sem descrição)')}${it.quem?`<small> · ${escHtml(it.quem)}</small>`:''}</span><span class="v">${eur(it.valor||0)}</span></div>`).join('')}</div>`:'';
        let dirChipsRow='';
        if(dirTot>0){
          const drChip=`<div class="rdc-chips"><span class="rc cv">Despesa Refeição ${eur(dirTot)}</span></div>`;
          dirChipsRow=dirItems.length?`<details class="rdc-det rdc-det-chips" onclick="event.stopPropagation()"><summary>${drChip}<span class="rdc-det-arrow">›</span></summary>${dirDetBody}</details>`:drChip;
        }
        costCards+=`<details class="rdc rdc-fold sf" onclick="event.stopPropagation()">
          <summary class="rdc-hdr"><span class="rdc-lbl">Custos diretos</span><span class="rdc-tot">${eur(dirTot)}</span>${ppTag(dirPP)}<span class="rdc-fold-arrow">›</span></summary>
          <div class="rdc-peso"><span class="rdc-peso-lbl">Compras</span><span class="rdc-peso-rule"></span></div>
          ${dirChipsRow}
          <div class="rdc-unit"><span>Por pessoa</span><span class="rdc-unit-v">${eur(dirPP)}</span></div>
        </details>`;
        const membrosCount=Math.max(0,calcRef.D-calcRef.E);
        const rkey=`${rd.dia}|${rd.ref==='Lanche'?'Tarde':rd.ref}`;
        const membrosCome=(DATA.membros||[]).filter(m=>(m.presencas||[]).some(p=>p.k===rkey&&p.modo==='come')).map(m=>m.nome).sort((a,b)=>a.localeCompare(b,'pt'));
        const guestsAll=(DATA.convidados||[]).filter(g=>g.dia===rd.dia&&g.ref===rd.ref);
        const guestsPay=guestsAll.filter(g=>g.pagante==='Sim');
        const pid='rdp'+rd._idx;
        const temDetM=membrosCome.length>0||guestsAll.length>0;
        const memPanel=temDetM?`<div class="rdc-ppl casais" id="${pid}m" style="display:none" onclick="event.stopPropagation()">${casaisPanelHtml(membrosCome,guestsAll)}</div>`:'';
        const guestPanel=guestsPay.length?`<div class="rdc-ppl" id="${pid}g" style="display:none" onclick="event.stopPropagation()">${guestsPay.map(g=>`<span class="rdc-ppl-it">${escHtml(g.nome)}${g.membro?`<small> · ${escHtml(g.membro)}</small>`:''}</span>`).join('')}</div>`:'';
        const memAttrs=temDetM?`class="rdc-cell rdc-cell-btn" data-tgt="${pid}m" onclick="event.stopPropagation();togglePeople('${pid}m')"`:'class="rdc-cell"';
        const guestAttrs=guestsPay.length?`class="rdc-cell rdc-cell-btn" data-tgt="${pid}g" onclick="event.stopPropagation();togglePeople('${pid}g')"`:'class="rdc-cell"';
        const membroCell=`<div ${memAttrs}><div class="rdc-cell-k">Membro${membrosCount?`<span class="rdc-cell-n">${membrosCount}</span>`:''}${temDetM?'<span class="rdc-cell-arrow">›</span>':''}</div><div class="rdc-cell-v rdc-cell-v-gold">${calcRef.D>0?eur(calcRef.P):'<span class="rdc-na">N/A</span>'}</div></div>`;
        const convCell=`<div ${guestAttrs}><div class="rdc-cell-k">Convidado${calcRef.E?`<span class="rdc-cell-n">${calcRef.E}</span>`:''}${guestsPay.length?'<span class="rdc-cell-arrow">›</span>':''}</div><div class="rdc-cell-v">${calcRef.E?eur(calcRef.Q):'<span class="rdc-na">N/A</span>'}</div></div>`;
        const presNota=calcRef.D>0?'':'<div class="rdc-sempres">Sem presenças marcadas</div>';
        costCards+=`<div class="rdc rdc-hero sf">
          <div class="rdc-hdr"><span class="rdc-lbl rdc-lbl-green">Custo da refeição</span><span class="rdc-tot">${eur(calcRef.custoTotal)}</span>${ppTag(rnd(indPP+dirPP,2))}<span class="rdc-fold-arrow" style="visibility:hidden">›</span></div>
          ${presNota}
          <div class="rdc-cells">${membroCell}${convCell}</div>
          ${memPanel}${guestPanel}
        </div>`;
      }
      // Ementa do dia — card campino em destaque: prato grande + entradas/sobremesa em linha
      const mp=parseMenuParts(rd.menu);
      const ementa=(rd.prato||mp.entradas||mp.sobremesa||mp.outras)?`<div class="ementa sf">
        <div class="ementa-hd">Prato do dia</div>
        ${rd.prato?`<div class="em-prato">${escHtml(rd.prato)}</div>`:''}
        ${(mp.entradas||mp.sobremesa||mp.outras)?'<div class="em-rule"></div>':''}
        ${mp.entradas?`<div class="em-linha"><span class="em-lk">Entradas</span>${escHtml(mp.entradas)}</div>`:''}
        ${mp.sobremesa?`<div class="em-linha"><span class="em-lk">Sobremesa</span>${escHtml(mp.sobremesa)}</div>`:''}
        ${mp.outras?`<div class="em-notas">${escHtml(mp.outras)}</div>`:''}
      </div>`:'';
      r+=`<div class="refmeal" data-i="${rd._idx}" style="${rd._idx===sel?'':'display:none'}">
        <div class="refdef-day-hdr sf">${diaExtenso(rd.data)||rd.dia} · ${rd.data}</div>
        <div class="refdef-row${isAdmin()?' refdef-click':''}" style="flex-wrap:wrap"${isAdmin()?` onclick="openRefdefModal(${rd._idx})"`:''}>
          <span class="refdef-icon">${icon}</span>
          <div class="refdef-info">
            <div class="refdef-ref sf">${rd.ref}${rd.respCozinha?`<span class="refdef-resp-inline sf"> · 👨‍🍳 ${escHtml(rd.respCozinha)}</span>`:''}</div>
          </div>
          ${isAdmin()?'<span class="refdef-chevron sf">›</span>':''}
          ${ementa}
          ${costCards}${mealShopSection(rd)}
        </div>
      </div>`;
    });
    r+='</div>';
  }
  r+=`<div class="refdef-add-bar"><button class="refdef-add-btn sf write-action admin-only" onclick="openRefdefModal()">＋ Adicionar Refeição</button></div>`;
  r+=`<details class="calc-help sf" style="margin-top:14px">
    <summary><span class="ch-ico">ⓘ</span> Como se calculam os custos? <span class="chev">›</span></summary>
    <div class="calc-help-body">
      <p><b>Indiretos</b> — as despesas de <b>bebidas</b>, <b>cerveja</b> e <b>gerais</b> juntam-se numa bolsa comum. O <b>peso</b> (%) de cada refeição define a fatia que lhe toca.</p>      <p><b>Diretos</b> — o que se gastou especificamente naquela refeição (o almoço/jantar em si).</p>
      <p><b>Custo da refeição</b> = diretos + indiretos.</p>
    </div>
  </details>`;
  r+='</div>';

  // ── SUB 2: Presenças ──
  r+='<div id="ref-sub-presencas" style="'+(REF_SUB==='presencas'?'':'display:none')+'">';
  if(_sbSession&&!isAdmin()&&!MY_NAMES.length){
    r+='<div class="perm-hint sf">👤 A tua conta ainda não está ligada a um membro do plantel. Pede ao administrador para te ligar e poderes marcar presenças, convidados e despesas.</div>';
  }
  r+=renderPresencaGrid();
  r+='</div>';

  // ── SUB 3: Convidados ──
  r+='<div id="ref-sub-convidados" style="'+(REF_SUB==='convidados'?'':'display:none')+'">';
  r+=renderGuestSection();
  r+='</div>';

  document.getElementById('view-refeicoes').innerHTML=r;

  // CASH-FLOWS — merge all 5 types into one list
  renderCashFlows();

  // Populate payment modal selects
  updateCfForm();
  if(TAB==='compras')renderCompras();
  if(TAB==='stock')renderStock();
  updateStockTabVis();
  // Mudou-se para um ano de contas fechadas com o separador Stock ativo → sair dele
  if(TAB==='stock'&&(!STOCK_TABLE||contasFechadas()))setTab('saldos');
  updateGuestFab();
}

let cfFilterType='all';
let cfFilterPerson='all';
let cfFilterSub='all';
let cfFilterView='mov';   // 'mov' = movimentos datados · 'previstas' = sem data

/* Reembolsos e dívidas pagas: não-admins só veem movimentos seus ou dos cônjuges */
function cfVisivel(cf){
  if(isAdmin())return true;
  if(cf.type!=='reembolso'&&cf.type!=='saldar')return true;
  if(!MY_NAMES.length)return false;
  if((cf.people||[]).some(n=>MY_NAMES.includes(n)))return true;
  if(cf.source==='pagamentos'){
    const p=DATA.pagamentos[cf.idx];
    if(p&&p.ref&&MY_NAMES.some(n=>p.ref.includes('own:'+n)||p.ref.includes('conv:'+n)))return true;
  }
  return false;
}

/* Ref de "saldar" legível: own:/conv: → nomes; vazio → adiantamento */
function sdRefLabel(ref){
  if(!ref)return 'Adiantamento';
  return ref.split(/,\s*/).filter(Boolean).map(k=>
    k.startsWith('own:')?k.slice(4):k.startsWith('conv:')?k.slice(5)+' (conv.)':k
  ).join(', ');
}

function renderCashFlows(){
  // Lista unificada de cash-flows (semântica de sinal na perspetiva do grupo:
  // despesa = sai dinheiro (−) · mealheiro = entra (+) · reembolso = transferência (→) · saldar = acerto (✓))
  const allCf=[];

  (DATA.pagamentos||[]).forEach((p,i)=>{
    const t=cfType(p);
    const l2=t==='reembolso'?(p.ref||'').replace(/^Reembolso:?\s*/,''):(t==='saldar'&&p.ref?'De: ':'')+sdRefLabel(p.ref);
    allCf.push({type:t,date:p.data||'',label:cfLabel(t),icon:cfIcon(t),
      line1:`${p.de} → ${p.para}`,line2:l2,valor:p.valor,
      sign:t==='reembolso'?'mov':'set',source:'pagamentos',idx:i,people:[p.de,p.para].filter(Boolean)});
  });

  (DATA.despesas||[]).forEach((d,i)=>{
    // Dia da semana (Almoço/Jantar) → junta-se ao badge do tipo, não ao de quem pagou
    let dia='';
    if((d.tipo==='Almoço'||d.tipo==='Jantar')&&d.dataValor){
      const dd=dataToDia(d.dataValor);
      if(dd)dia=dd;
    }
    const prevista=!d.dataDesp&&!d.dataValor;
    allCf.push({type:'despesa',date:d.dataDesp||d.dataValor||'',label:'Despesa',icon:'🛒',sub:d.tipo||'Gerais',dia,prevista,obs:d.obs||'',fromList:!!d.compraId,compraId:d.compraId||null,quem:d.quem,
      line1:d.desc||'(sem descrição)',line2:`${prevista?'pagará':'pagou'} ${d.quem}`,valor:d.valor,
      sign:'neg',source:'despesas',idx:i,people:[d.quem]});
  });

  (DATA.mealheiros||[]).forEach((m,i)=>{
    const subIcons={'sobras_ano_anterior':[ICON_SACO,'Sobras Ano Anterior'],'outros':[ICON_MOEDA,'Outros']};
    const [mIcon,mLabel]=subIcons[m.subtipo]||[ICON_LATA,'Lata'];
    allCf.push({type:'mealheiro',date:m.data||'',label:mLabel,icon:mIcon,sub:mLabel,
      line1:`${m.quem} recebeu`,line2:m.desc||'',valor:m.valor,
      sign:'pos',source:'mealheiros',idx:i,people:[m.quem]});
  });

  allCf.sort((a,b)=>(b.date||'').localeCompare(a.date||''));

  // Visibilidade por utilizador (reembolsos/saldar restritos a não-admins)
  const visCf=allCf.filter(cfVisivel);

  // Agrupamento (só apresentação): as despesas da mesma compra da lista juntam-se
  // num cartão. Uma compra conta como 1 movimento e o seu valor é a soma das linhas.
  const visGrouped=groupCompraCfs(visCf);

  // Totais por tipo (do conjunto completo, já agrupado — uma compra = 1 despesa)
  const tot={despesa:0,reembolso:0,mealheiro:0,saldar:0};
  const cnt={despesa:0,reembolso:0,mealheiro:0,saldar:0};
  visGrouped.forEach(cf=>{tot[cf.type]=(tot[cf.type]||0)+cf.valor;cnt[cf.type]=(cnt[cf.type]||0)+1;});

  // Pessoas para filtro
  const personSet=new Set();
  visCf.forEach(cf=>(cf.people||[]).forEach(p=>personSet.add(p)));
  const personList=[...personSet].sort((a,b)=>a.localeCompare(b,'pt'));
  // Filtro-fantasma: se a pessoa escolhida não existe neste mês/ano, o <select>
  // volta visualmente a "Todas as pessoas" mas a variável ficava presa no nome
  // antigo — a lista filtrava por alguém sem movimentos e aparecia vazia (0 de N).
  if(cfFilterPerson!=='all'&&!personList.includes(cfFilterPerson))cfFilterPerson='all';

  // Resumo: resultado líquido do grupo (entradas − saídas) + 4 pílulas-filtro
  // numa só fila, sem scroll horizontal.
  const liq=rnd((tot.mealheiro||0)-(tot.despesa||0),2);
  const pill=(t,icon,lbl,cls,sgn)=>`
    <div class="cfc-pill b-${t}${cfFilterType===t?' on':''}" onclick="cfFilterType=cfFilterType==='${t}'?'all':'${t}';cfFilterSub='all';renderCashFlows()">
      <b class="${cls}">${sgn}${eur(tot[t]||0)}</b>
      <small class="sf">${icon} ${lbl} <i>${cnt[t]||0}</i></small>
    </div>`;
  let pp=`<div class="card cfc-net">
    <div>
      <div class="cfc-net-lbl sf">Resultado do grupo</div>
      <div class="cfc-net-val ${liq<0?'neg':'pos'}">${liq<0?'−':'+'}${eur(Math.abs(liq))}</div>
    </div>
    <div class="cfc-net-cols sf">
      <small>entradas</small><b class="pos">+${eur(tot.mealheiro||0)}</b>
      <small>saídas</small><b class="neg">−${eur(tot.despesa||0)}</b>
    </div>
  </div>
  <div class="cfc-pills">
    ${pill('despesa','🛒','Despesas','neg','−')}
    ${pill('mealheiro','🐷','Mealheiro','pos','+')}
    ${pill('reembolso','💸','Reembolsos','mov','')}
    ${pill('saldar','🤝','Dívidas','set','')}
  </div>`;

  // Filtro de pessoa (mantém-se em select — 19+ nomes)
  pp+=`<div class="cf-filters">
    <div class="cf-filter" style="flex:1"><select onchange="cfFilterPerson=this.value;renderCashFlows()">
      <option value="all"${cfFilterPerson==='all'?' selected':''}>Todas as pessoas</option>
      ${personList.map(p=>`<option value="${p}"${cfFilterPerson===p?' selected':''}>${p}</option>`).join('')}
    </select></div>
  </div>`;

  // Sub-filtros variáveis (subtipos de despesa / mealheiro)
  if(cfFilterType==='despesa'||cfFilterType==='mealheiro'){
    const subs=[...new Set(visCf.filter(c=>c.type===cfFilterType&&c.sub).map(c=>c.sub))];
    if(subs.length>1){
      pp+=`<div class="cf-subchips">
        <div class="cf-subchip${cfFilterSub==='all'?' on':''}" onclick="cfFilterSub='all';renderCashFlows()">Todos</div>
        ${subs.map(s=>`<div class="cf-subchip${cfFilterSub===s?' on':''}" onclick="cfFilterSub='${s.replace(/'/g,"\\'")}';renderCashFlows()">${s}</div>`).join('')}
      </div>`;
    }
  }

  // Aplicar filtros
  let filtered=visCf;
  if(cfFilterType!=='all') filtered=filtered.filter(cf=>cf.type===cfFilterType);
  if(cfFilterSub!=='all') filtered=filtered.filter(cf=>cf.sub===cfFilterSub);
  if(cfFilterPerson!=='all'){
    const memberGuests=(DATA.convidados||[]).filter(g=>g.membro===cfFilterPerson).map(g=>g.nome);
    filtered=filtered.filter(cf=>{
      if((cf.people||[]).includes(cfFilterPerson)) return true;
      if(cf.source==='pagamentos'){
        const p=DATA.pagamentos[cf.idx];
        if(p.ref && (p.ref.includes('own:'+cfFilterPerson) || p.ref.includes('conv:'+cfFilterPerson))) return true;
      }
      if(memberGuests.length && cf.people){
        if(cf.people.some(x=>memberGuests.includes(x))) return true;
      }
      return false;
    });
  }

  // Agrupa para apresentação (exceto ao filtrar por sub-tipo — aí mostram-se as
  // linhas individuais que correspondem ao filtro).
  const display=(cfFilterSub==='all')?groupCompraCfs(filtered):filtered;
  const totalCount=(cfFilterSub==='all')?visGrouped.length:visCf.length;

  // As despesas sem data (previstas) vivem num 2.º tabulador em vez de
  // aparecerem no fim da cronologia.
  const dated=display.filter(cf=>cf.date);
  const undated=display.filter(cf=>!cf.date);
  if(!undated.length)cfFilterView='mov';
  if(undated.length){
    pp+=`<div class="sub-tabs cfc-tabs">
      <div class="sub-tab${cfFilterView==='mov'?' on':''}" onclick="cfFilterView='mov';renderCashFlows()">Movimentos</div>
      <div class="sub-tab${cfFilterView==='previstas'?' on':''}" onclick="cfFilterView='previstas';renderCashFlows()">📌 Previstas · ${undated.length}</div>
    </div>`;
  }
  const shown=cfFilterView==='previstas'?undated:dated;

  const filteredTotal=shown.reduce((a,cf)=>a+cf.valor,0);
  const showTotal=(cfFilterView==='previstas'||cfFilterType!=='all'||cfFilterPerson!=='all')&&shown.length>0;
  pp+=`<div class="sec-title sf" style="display:flex;justify-content:space-between;align-items:center">
    <span>${cfFilterView==='previstas'?'Previstas':'Movimentos'} (${shown.length}${cfFilterView==='mov'&&shown.length!==totalCount?' de '+totalCount:''})</span>
    ${showTotal?`<span style="color:var(--gold);font-size:12px;font-weight:700;letter-spacing:0">${eur(filteredTotal)}</span>`:''}
  </div>`;
  if(!shown.length) pp+='<div class="empty sf">Nenhum movimento encontrado</div>';

  // Cronologia: calha de datas à esquerda, cartões simplificados à direita,
  // com separadores de mês. O tipo é dado pela cor + rótulo pequeno (sem chips);
  // o valor fica na linha do título para o rótulo não criar espaçamento extra.
  const cardHtml=cf=>{
    if(cf.isCompra){
      // Cartão de compra da lista: resumo + linhas por refeição/tipo. Toca → editor da compra.
      const lines=cf.lines.map(l=>`<div class="cft-sub"><span>${shopTipoIcon(l.sub)} ${l.sub}${l.dia?' · '+l.dia:''}${l.obs?' · <i>'+escHtml(l.obs)+'</i>':''}</span><span>−${eur(l.valor)}</span></div>`).join('');
      return `<div class="card cft-card b-despesa" onclick="openCompra('${cf.compraId}')">
        <div class="cft-kind k-despesa sf">🛒 Compra · lista</div>
        <div class="cft-l1"><div class="cft-title">${escHtml(cf.line1)}</div><span class="cft-v neg">−${eur(cf.valor)}</span></div>
        ${cf.line2?`<div class="cft-meta">${truncRef(cf.line2)}</div>`:''}
        <div class="cft-subs">${lines}</div>
      </div>`;
    }
    const sgn=cf.sign==='neg'?'−':cf.sign==='pos'?'+':'';
    const kind=cf.type==='despesa'?('Despesa'+(cf.sub?' · '+cf.sub:'')+(cf.dia?' · '+cf.dia:''))
      :cf.type==='mealheiro'?('Mealheiro · '+(cf.sub||'Lata'))
      :cf.label;
    const meta=[];
    if(cf.line2)meta.push(truncRef(cf.line2));
    if(cf.fromList)meta.push('🛒 lista');
    return `<div class="card cft-card b-${cf.type}${cf.prevista?' cft-prevista':''}" onclick="openCfDetail('${cf.source}',${cf.idx})">
      <div class="cft-kind k-${cf.type} sf">${cf.prevista?'📌':cf.icon} ${kind}</div>
      <div class="cft-l1"><div class="cft-title">${cf.line1}</div><span class="cft-v ${cf.sign}">${sgn}${eur(cf.valor)}</span></div>
      ${meta.length?`<div class="cft-meta">${meta.join(' · ')}</div>`:''}
      ${cf.obs?`<div class="cft-obs">${escHtml(cf.obs)}</div>`:''}
    </div>`;
  };
  if(cfFilterView==='previstas'){
    // Previstas: pilha simples, sem calha de datas
    pp+=`<div class="cfc-prev-list">${shown.map(cardHtml).join('')}</div>`;
  }else{
    const days=[];let cur=null;
    shown.forEach(cf=>{
      if(!cur||cur.date!==cf.date){cur={date:cf.date,items:[]};days.push(cur);}
      cur.items.push(cf);
    });
    let lastM;
    days.forEach(d=>{
      const dt=new Date(d.date+'T12:00:00');
      const ok=!isNaN(dt);
      const mkey=d.date.slice(0,7);
      if(mkey!==lastM){
        lastM=mkey;
        pp+=`<div class="cft-month">${ok?dt.toLocaleDateString('pt-PT',{month:'long',year:'numeric'}):d.date}</div>`;
      }
      pp+=`<div class="cft-day">
        <div class="cft-rail"><div class="cft-date"><b>${ok?dt.getDate():'?'}</b><span>${ok?dt.toLocaleDateString('pt-PT',{weekday:'short'}).replace(/\./g,''):'—'}</span></div><div class="cft-line"></div></div>
        <div class="cft-cards">${d.items.map(cardHtml).join('')}</div>
      </div>`;
    });
  }
  document.getElementById('view-cashflows').innerHTML=pp;
}

/* Agrupa as despesas da mesma compra da lista (compra_id) num único movimento.
   Só apresentação: os cálculos e os filtros continuam a usar as despesas linha a linha. */
function groupCompraCfs(list){
  const out=[];const byId={};
  list.forEach(cf=>{
    if(cf.type==='despesa'&&cf.compraId){
      let g=byId[cf.compraId];
      if(!g){
        g={type:'despesa',isCompra:true,compraId:cf.compraId,date:cf.date,icon:'🛒',label:'Compra',
           line1:'',line2:cf.line2,valor:0,sign:'neg',people:cf.people?[...cf.people]:[],lines:[],_desc:''};
        byId[cf.compraId]=g;out.push(g);
      }
      g.valor=rnd(g.valor+cf.valor,2);
      g.lines.push({sub:cf.sub,dia:cf.dia,valor:cf.valor,obs:cf.obs});
      if(cf.date&&(!g.date||cf.date<g.date))g.date=cf.date;   // dia mais antigo
      if(!g._desc&&cf.line1&&cf.line1!=='Compras'&&cf.line1!=='(sem descrição)')g._desc=cf.line1;
    }else out.push(cf);
  });
  out.forEach(g=>{if(g.isCompra){g.line1=g._desc||'Compra da lista';g.subN=g.lines.length;}});
  return out;
}

function truncRef(s){return s.length>40?s.slice(0,37)+'…':s;}
function escHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

function openMember(nome){
  const m=CALC.membros.find(x=>x.nome===nome);if(!m)return;
  const tes=DATA.evento.tesoureiro;
  const isTes=m.nome===tes;
  let h='';

  // ── Helper: calcular valores ──
  const pagAll=CALC.pagamentos;
  const pagNonReemb=pagAll.filter(p=>!p.ref||!p.ref.startsWith('Reembolso'));
  const reembolsosRecebidos=pagAll.filter(p=>p.ref&&p.ref.startsWith('Reembolso')&&p.para===m.nome).reduce((a,p)=>a+p.valor,0);
  const reembolsosFeitos=pagAll.filter(p=>p.ref&&p.ref.startsWith('Reembolso')&&p.de===m.nome).reduce((a,p)=>a+p.valor,0);
  const totalPagoDespesas=DATA.despesas.filter(x=>x.quem===m.nome).reduce((a,x)=>a+x.valor,0);
  const recebimentos=pagNonReemb.filter(p=>p.para===m.nome).reduce((a,p)=>a+p.valor,0);
  const mealTotal=rnd((m.W||0)+(m.X||0),2);

  // ═══════════════════════════════════════
  // 1. CONTRIBUIÇÕES (débito — vermelho)
  // ═══════════════════════════════════════
  const contribTotal=rnd(m.Sown+m.AA,2);
  if(contribTotal>0){
    h+='<div class="bd-title sf">Contribuições</div>';
    if(m._refs.length){
      const comeR=m._refs.filter(r=>r.modo!=='bebe');
      const bebeR=m._refs.filter(r=>r.modo==='bebe');
      const sCome=rnd(comeR.reduce((a,x)=>a+x.p,0),2);
      const sBebe=rnd(bebeR.reduce((a,x)=>a+x.p,0),2);
      if(comeR.length){
        h+=`<div class="collapse-toggle" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
          <span class="ct-label">🍽 Refeições (${comeR.length})</span>
          <span><span class="ct-val minus">${eur(sCome)}</span><span class="ct-arrow">▼</span></span>
        </div>`;
        h+='<div class="collapse-body"><div class="meals">';
        comeR.forEach(r=>h+=`<div class="meal"><span class="d">${r.dia} · ${r.ref}</span><span class="p">${eur(r.p)}</span></div>`);
        h+='</div></div>';
      }
      if(bebeR.length){
        h+=`<div class="collapse-toggle" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')"${comeR.length?' style="margin-top:6px"':''}>
          <span class="ct-label">🍺 Só bebida (${bebeR.length})</span>
          <span><span class="ct-val minus">${eur(sBebe)}</span><span class="ct-arrow">▼</span></span>
        </div>`;
        h+='<div class="collapse-body"><div class="meals">';
        bebeR.forEach(r=>h+=`<div class="meal"><span class="d">${r.dia} · ${r.ref}</span><span class="p">${eur(r.p)}</span></div>`);
        h+='</div></div>';
      }
    }
    if(m._convs.length){
      h+=`<div class="collapse-toggle" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')" style="margin-top:6px">
        <span class="ct-label">👥 Convidados (${m._convs.length})</span>
        <span><span class="ct-val minus">${eur(m.AA)}</span><span class="ct-arrow">▼</span></span>
      </div>`;
      h+='<div class="collapse-body"><div class="meals">';
      m._convs.forEach(c=>h+=`<div class="meal"><span class="d">${c.nome} · ${c.dia} ${c.ref}</span><span class="p">${eur(c.q)}</span></div>`);
      h+='</div></div>';
    }
  }

  // ═══════════════════════════════════════
  // 2. QUOTA EXTRA (débito — vermelho)
  // ═══════════════════════════════════════
  const quotaExtra=rnd((m.R||0)+(m.U||0),2);
  if(quotaExtra>0){
    h+='<div class="bd-title sf">Quota Extra</div>';
    if(m.R>0){h+=`<div class="li"><span class="lbl">Quota adicional<small>fator ${fmtFator(m.fatorEf!=null?m.fatorEf:m.fator)}</small></span><span class="val minus">${eur(m.R)}</span></div>`;}
    if(m.U>0){h+=`<div class="li"><span class="lbl">Missão poupança</span><span class="val minus">${eur(m.U)}</span></div>`;}
  }

  // ═══════════════════════════════════════
  // 3. DESPESAS ADIANTADAS (crédito — verde)
  // ═══════════════════════════════════════
  if(totalPagoDespesas>0){
    h+='<div class="bd-title sf">Despesas Adiantadas</div>';
    h+=`<div class="li"><span class="lbl">Despesas que pagaste<small>do teu bolso para o grupo</small></span><span class="val plus">${eur(rnd(totalPagoDespesas,2))}</span></div>`;
  }

  // ═══════════════════════════════════════
  // 4. REEMBOLSOS DE DESPESAS
  // ═══════════════════════════════════════
  if(reembolsosFeitos>0||reembolsosRecebidos>0){
    h+='<div class="bd-title sf">Reembolsos de Despesas</div>';
    if(reembolsosFeitos>0){h+=`<div class="li"><span class="lbl">Reembolsos que fizeste<small>dinheiro devolvido a quem adiantou</small></span><span class="val minus">${eur(rnd(reembolsosFeitos,2))}</span></div>`;}
    if(reembolsosRecebidos>0){h+=`<div class="li"><span class="lbl">Reembolsos recebidos<small>dinheiro que te devolveram</small></span><span class="val plus">${eur(rnd(reembolsosRecebidos,2))}</span></div>`;}
  }

  // ═══════════════════════════════════════
  // 5. MEALHEIRO (débito para quem recebeu)
  // ═══════════════════════════════════════
  if(mealTotal>0){
    h+='<div class="bd-title sf">Mealheiro</div>';
    h+=`<div class="li"><span class="lbl">Lata, sobras e outros<small>créditos recebidos do mealheiro</small></span><span class="val minus">${eur(mealTotal)}</span></div>`;
  }

  // ═══════════════════════════════════════
  // 6. PAGAMENTOS RECEBIDOS
  // ═══════════════════════════════════════
  if(recebimentos>0||(!isTes&&m._payerOwnPortion>0)){
    h+='<div class="bd-title sf">Pagamentos Recebidos</div>';
    if(recebimentos>0){h+=`<div class="li"><span class="lbl">Recebimentos<small>${isTes?'pagamentos dos membros':'pagamentos recebidos'}</small></span><span class="val minus">${eur(rnd(recebimentos,2))}</span></div>`;}
    if(!isTes){
      const ownPortion=rnd(m._payerOwnPortion,2);
      if(ownPortion>0){h+=`<div class="li"><span class="lbl">Pagaste para saldar<small>parte referente às tuas contas</small></span><span class="val plus">${eur(ownPortion)}</span></div>`;}
      const paidByOthers=m._creditedBy.filter(c=>c.payer!==m.nome);
      if(paidByOthers.length){
        const byPayer={};paidByOthers.forEach(c=>{byPayer[c.payer]=(byPayer[c.payer]||0)+c.amount;});
        for(const[payer,amt] of Object.entries(byPayer)){
          if(amt>0){h+=`<div class="li"><span class="lbl">Pago por ${payer}<small>saldou a tua dívida</small></span><span class="val plus">${eur(rnd(amt,2))}</span></div>`;}
        }
      }
    }
  }

  // ═══════════════════════════════════════
  // SALDO FINAL
  // ═══════════════════════════════════════
  // Créditos = despesas adiantadas + reembolsos feitos (tesoureiro) + pagamentos próprios (não tesoureiro) + pago por outros
  let totalCreditos=0;
  totalCreditos+=totalPagoDespesas;
  if(isTes) totalCreditos+=reembolsosFeitos;
  if(!isTes){
    totalCreditos+=rnd(m._payerOwnPortion,2);
    const paidByOthers=m._creditedBy.filter(c=>c.payer!==m.nome);
    paidByOthers.forEach(c=>{totalCreditos+=c.amount;});
  }
  totalCreditos=rnd(totalCreditos,2);

  // Débitos = contribuições + quota extra + mealheiro + recebimentos + reembolsos recebidos
  let totalDebitos=rnd(contribTotal+quotaExtra+mealTotal+recebimentos+reembolsosRecebidos,2);
  // Reembolsos feitos pelo tesoureiro são débito (saiu dinheiro dele)
  // Não — reembolsos feitos são crédito (ele pagou para devolver). Já está em créditos.
  // Reembolsos recebidos são débito (ficou com dinheiro). Já está.

  const sfEcra=rnd(totalCreditos-totalDebitos,2);
  const clsE=Math.abs(sfEcra)<0.005?'':(sfEcra>0?'pos':'neg');
  const saldoLabel=sfEcra>0.005?'a receber':(sfEcra<-0.005?'a pagar':'saldado');

  h+='<div class="bd-title sf">Saldo Final</div>';
  h+=`<div class="li"><span class="lbl">Créditos</span><span class="val plus">${eur(totalCreditos)}</span></div>`;
  h+=`<div class="li"><span class="lbl">Débitos</span><span class="val minus">${eur(totalDebitos)}</span></div>`;
  h+=`<div class="li tot"><span class="lbl">Saldo <small>${saldoLabel}</small></span><span class="val ${clsE}">${eur(sfEcra)}</span></div>`;

  // ── Guardar saldo para uso no resumo ──
  m._sfEcra=sfEcra;

  document.getElementById('sheet-hdr').innerHTML=`
    <div class="grab"></div>
    <div class="sheet-header-row">
      ${av(nome,CALC.membros.indexOf(m))}
      <span class="sheet-header-name">${nome}</span>
      <button class="back-btn" onclick="closeSheet()">✕</button>
    </div>`;
  document.getElementById('sheet-in').innerHTML=h;
  document.getElementById('sheet-bg').classList.add('show');document.getElementById('sheet').classList.add('show');
  document.body.classList.add('no-scroll');
  document.getElementById('sheet-in').scrollTop=0;
}
function closeSheet(){
  document.getElementById('sheet-bg').classList.remove('show');
  document.getElementById('sheet').classList.remove('show');
  document.body.classList.remove('no-scroll');
}

/* SYNC */
function setSync(st,txt){const d=document.getElementById('sync-dot');const t=document.getElementById('sync-txt');
  if(st==='load'){d.outerHTML='<span class="spin" id="sync-dot"></span>';}
  else{const el=document.getElementById('sync-dot');if(el.tagName!=='SPAN'||el.classList.contains('spin')){el.outerHTML=`<span class="dot ${st==='live'?'live':st==='err'?'err':''}" id="sync-dot"></span>`;}
  else{el.className='dot'+(st==='live'?' live':st==='err'?' err':'');}}t.textContent=txt;}
function toast(msg,kind){const t=document.getElementById('toast');t.textContent=msg;t.className='toast show '+(kind||'');setTimeout(()=>t.className='toast',3000);}

async function carregar(){
  setSync('load','a sincronizar…');
  try{
    const sel='*,membros(*,presencas(*)),refeicoes_def(*),despesas(*),convidados(*),mealheiros(*),pagamentos(*)';
    // shoplist vai numa fetch SEPARADA e tolerante a falha: se a tabela ainda
    // não existir (migração por correr) o resto da app continua a funcionar.
    const [res,uaRes,cjRes,vlRes,slRes,stRes,ctRes,acRes]=await Promise.all([
      sbFetch(`${SB_URL}/rest/v1/eventos?select=${encodeURIComponent(sel)}&order=ano.asc`,{headers:sbHeaders(),cache:'no-store'}),
      sbFetch(`${SB_URL}/rest/v1/user_amigos?select=email,amigo`,{headers:sbHeaders(),cache:'no-store'}).catch(()=>null),
      sbFetch(`${SB_URL}/rest/v1/conjuges?select=amigo_a,amigo_b`,{headers:sbHeaders(),cache:'no-store'}).catch(()=>null),
      sbFetch(`${SB_URL}/rest/v1/validacoes?select=evento_id,amigo,validado_por_email,validado_por_amigo,validado_em`,{headers:sbHeaders(),cache:'no-store'}).catch(()=>null),
      sbFetch(`${SB_URL}/rest/v1/shoplist?select=*`,{headers:sbHeaders(),cache:'no-store'}).catch(()=>null),
      // stock_lotes: fetch tolerante — sem a migração corrida a app funciona sem stock
      sbFetch(`${SB_URL}/rest/v1/stock_lotes?select=*`,{headers:sbHeaders(),cache:'no-store'}).catch(()=>null),
      // categorias de artigos (db/categorias.sql): também tolerantes — sem a
      // migração, CATS_TABLE=false e tudo o que é categorias fica escondido
      sbFetch(`${SB_URL}/rest/v1/categorias?select=*`,{headers:sbHeaders(),cache:'no-store'}).catch(()=>null),
      sbFetch(`${SB_URL}/rest/v1/artigo_categorias?select=*`,{headers:sbHeaders(),cache:'no-store'}).catch(()=>null)
    ]);
    if(!res.ok)throw new Error('HTTP '+res.status);
    const rows=await res.json();
    USER_AMIGOS=(uaRes&&uaRes.ok)?await uaRes.json():[];
    CONJUGES=(cjRes&&cjRes.ok)?await cjRes.json():[];
    VALIDACOES=(vlRes&&vlRes.ok)?await vlRes.json():[];
    const shopRows=(slRes&&slRes.ok)?await slRes.json():[];
    STOCK_TABLE=!!(stRes&&stRes.ok);
    const stockRows=STOCK_TABLE?await stRes.json():[];
    CATS_TABLE=!!(ctRes&&ctRes.ok&&acRes&&acRes.ok);
    CATEGORIAS=CATS_TABLE?(await ctRes.json()).sort((a,b)=>a.nome.localeCompare(b.nome,'pt')):[];
    ART_CATS={};
    if(CATS_TABLE)(await acRes.json()).forEach(r=>{ART_CATS[r.artigo_key]={catId:r.categoria_id,origem:r.origem||'manual'};});
    const stockByEv={};stockRows.forEach(s=>{(stockByEv[s.evento_id]=stockByEv[s.evento_id]||[]).push(s);});
    // Só gravamos os responsáveis se as colunas já existirem no Supabase
    // (senão o replace das refeições falhava todo — padrão dividas_publicas)
    REFDEF_RESP_COLS=rows.some(ev=>(ev.refeicoes_def||[]).some(r=>'resp_cozinha' in r));
    const shopByEv={};shopRows.forEach(s=>{(shopByEv[s.evento_id]=shopByEv[s.evento_id]||[]).push(s);});
    computeMyNames();
    const N=v=>v==null?0:Number(v);
    ALL_YEARS=rows.map(ev=>({
      _sbId: ev.id,
      evento:{nome:ev.nome,ano:ev.ano,tesoureiro:ev.tesoureiro,arredondaTotal:!!ev.arredonda_total,missaoPoupanca:N(ev.missao_poupanca),fundoReserva:N(ev.fundo_reserva),fatorModo:ev.fator_modo||'fixo',fatorThreshold:ev.fator_threshold!=null?N(ev.fator_threshold):FATOR_THRESHOLD_DEFAULT,dividasPublicas:!!ev.dividas_publicas,dividasPublicasCol:('dividas_publicas' in ev),contasFechadas:!!ev.contas_fechadas,contasFechadasEm:ev.contas_fechadas_em||null,contasFechadasPor:ev.contas_fechadas_por||null},
      membros:(ev.membros||[]).sort((a,b)=>a.nome.localeCompare(b.nome,'pt')).map(m=>({
        _id:m.id,nome:m.nome,fator:N(m.fator),sexo:m.sexo==='F'?'F':'M',
        presencas:(m.presencas||[]).map(p=>({k:`${p.dia}|${p.ref}`,modo:p.modo==='bebe'?'bebe':'come'}))
      })),
      refeicoesDef:(ev.refeicoes_def||[]).map(r=>({data:r.data,dia:r.dia,ref:r.ref,prato:r.prato||'',peso:N(r.peso),minMEO:N(r.min_meo),minConv:N(r.min_conv),extraConv:N(r.extra_conv),respCozinha:r.resp_cozinha||'',menu:r.menu||''})),
      despesas:(ev.despesas||[]).map(d=>({_id:d.id,quem:d.quem,dataDesp:d.data_desp,dataValor:d.data_valor,desc:d.descricao,tipo:d.tipo,valor:N(d.valor),obs:d.observacoes||'',compraId:d.compra_id||null})),
      convidados:(ev.convidados||[]).map(c=>({_id:c.id,membro:c.membro,nome:c.nome,data:c.data,dia:c.dia,ref:c.ref,pagante:c.pagante?'Sim':'Não',preco:N(c.preco)})),
      mealheiros:(ev.mealheiros||[]).map(m=>({quem:m.quem,data:m.data,valor:N(m.valor),subtipo:m.subtipo,desc:m.descricao})),
      pagamentos:(ev.pagamentos||[]).map(p=>({de:p.de,para:p.para,valor:N(p.valor),ref:p.ref,data:p.data,extra:N(p.extra)})),
      shoplist:(shopByEv[ev.id]||[]).map(s=>({_id:s.id,artigo:s.artigo,quantidade:s.quantidade||'',tamanho:s.tamanho||'',tipo:s.tipo,dataValor:s.data_valor,estado:s.estado||'pendente',tratadoPor:s.tratado_por||null,noCarrinho:!!s.no_carrinho,compraId:s.compra_id||null,cfDesc:s.cf_desc||null,valor:s.valor!=null?N(s.valor):null,criadoPor:s.criado_por||'',criadoEm:s.criado_em,compradoEm:s.comprado_em})),
      stockLotes:(stockByEv[ev.id]||[]).map(l=>({_id:l.id,compraId:l.compra_id,artigo:l.artigo,qtd:N(l.qtd),unidade:l.unidade||'',valor:N(l.valor),alocacoes:Array.isArray(l.alocacoes)?l.alocacoes:[],criadoEm:l.criado_em}))
    }));
    ALL_YEARS.sort((a,b)=>(a.evento.ano||0)-(b.evento.ano||0));
    // Restaurar onde o utilizador estava (ano + separadores), senão ano mais recente
    const savedAno=parseInt(lsGet('fbv_ano'),10);
    const yi=ALL_YEARS.findIndex(y=>y.evento.ano===savedAno);
    YEAR_IDX=yi>=0?yi:ALL_YEARS.length-1;
    const savedSub=lsGet('fbv_refsub');
    if(savedSub==='calendario'||savedSub==='presencas'||savedSub==='convidados')REF_SUB=savedSub;
    const savedMeal=parseInt(lsGet('fbv_refmeal'),10);
    if(Number.isInteger(savedMeal)&&savedMeal>=0)REF_SEL=savedMeal;
    selectYear();
    const savedTab=lsGet('fbv_tab')==='resumo'?'saldos':lsGet('fbv_tab');
    if(['saldos','refeicoes','cashflows','compras','stock'].includes(savedTab))setTab(savedTab);
    setSync('live','sincronizado · '+new Date().toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'}));
    updateReadOnlyMode();
  }catch(e){setSync('err','sem ligação');toast('Erro: '+e.message,'bad');}
}

async function pushToGitHub(msg){
  if(!_sbSession){toast('Sessão expirada — volta a entrar','bad');return false;}
  ALL_YEARS[YEAR_IDX]=Object.assign(JSON.parse(JSON.stringify(DATA)),{_sbId:DATA._sbId});
  const snap=JSON.parse(JSON.stringify(ALL_YEARS[YEAR_IDX]));
  const slot=YEAR_IDX;
  _writeBusy++;
  _writeChain=_writeChain.then(()=>sbGuardarEvento(snap,slot)).catch(()=>false).finally(()=>{_writeBusy--;});
  return _writeChain;
}

async function sbReq(method,path,body,extra){
  const opt={method,headers:sbHeaders(extra||{})};
  if(body!==undefined)opt.body=JSON.stringify(body);
  const r=await sbFetch(`${SB_URL}/rest/v1/${path}`,opt);
  if(!r.ok){let m='HTTP '+r.status;try{const j=await r.json();m=j.message||m;}catch(_){ }throw new Error(m);}
  const tx=await r.text();
  return tx?JSON.parse(tx):null;
}

async function sbGuardarEvento(y,slot){
  try{
    setSync('load','a guardar…');
    const ev=y.evento;
    const evRow={nome:ev.nome,ano:ev.ano,tesoureiro:ev.tesoureiro,arredonda_total:!!ev.arredondaTotal,missao_poupanca:ev.missaoPoupanca||0,fundo_reserva:ev.fundoReserva||0,fator_modo:ev.fatorModo==='variavel'?'variavel':'fixo',fator_threshold:ev.fatorThreshold!=null?ev.fatorThreshold:FATOR_THRESHOLD_DEFAULT};
    // Só grava a flag se a coluna já existir no Supabase (migração: ALTER TABLE eventos ADD dividas_publicas)
    if(ev.dividasPublicasCol)evRow.dividas_publicas=!!ev.dividasPublicas;
    let eid=y._sbId;
    if(!eid){
      const ins=await sbReq('POST','eventos',evRow,{Prefer:'return=representation'});
      eid=ins[0].id;
      y._sbId=eid;
      if(ALL_YEARS[slot])ALL_YEARS[slot]._sbId=eid;
      if(DATA&&DATA.evento.ano===ev.ano)DATA._sbId=eid;
    }else{
      await sbReq('PATCH',`eventos?id=eq.${eid}`,evRow);
    }
    // Substituir filhas (DELETE membros faz cascade às presenças)
    for(const t of ['membros','refeicoes_def','despesas','convidados','mealheiros','pagamentos'])
      await sbReq('DELETE',`${t}?evento_id=eq.${eid}`);
    // membros com return=representation para mapear nome -> id (FK das presenças)
    let idByNome=null;
    if(y.membros.length){
      const mres=await sbReq('POST','membros',y.membros.map(m=>({evento_id:eid,nome:m.nome,fator:m.fator||0,sexo:m.sexo==='F'?'F':'M'})),{Prefer:'return=representation'});
      idByNome={};mres.forEach(r=>idByNome[r.nome]=r.id);
      y.membros.forEach(m=>{if(idByNome[m.nome])m._id=idByNome[m.nome];});
      const pres=[];
      y.membros.forEach(m=>(m.presencas||[]).forEach(p=>{const[dia,ref]=p.k.split('|');pres.push({membro_id:idByNome[m.nome],dia,ref,modo:p.modo||'come'});}));
      if(pres.length)await sbReq('POST','presencas',pres);
    }
    if(y.refeicoesDef&&y.refeicoesDef.length)
      await sbReq('POST','refeicoes_def',y.refeicoesDef.map(r=>{
        const row={evento_id:eid,data:r.data,dia:r.dia,ref:r.ref,prato:r.prato||null,peso:r.peso||0,min_meo:r.minMEO||0,min_conv:r.minConv||0,extra_conv:r.extraConv||0};
        if(REFDEF_RESP_COLS){row.resp_cozinha=r.respCozinha||null;row.menu=r.menu||null;}
        return row;
      }));
    if(y.despesas&&y.despesas.length){
      const dres=await sbReq('POST','despesas',y.despesas.map(d=>({evento_id:eid,quem:d.quem,data_desp:d.dataDesp||null,data_valor:d.dataValor||null,descricao:d.desc||'',tipo:d.tipo,valor:d.valor,observacoes:d.obs||null,compra_id:d.compraId||null})),{Prefer:'return=representation'});
      if(Array.isArray(dres))dres.forEach((r,i)=>{if(y.despesas[i])y.despesas[i]._id=r.id;});
    }
    if(y.convidados&&y.convidados.length){
      const cres=await sbReq('POST','convidados',y.convidados.map(c=>({evento_id:eid,membro:c.membro,nome:c.nome,data:c.data||null,dia:c.dia,ref:c.ref,pagante:c.pagante==='Sim',preco:c.preco||0})),{Prefer:'return=representation'});
      if(Array.isArray(cres))cres.forEach((r,i)=>{if(y.convidados[i])y.convidados[i]._id=r.id;});
    }
    if(y.mealheiros&&y.mealheiros.length)
      await sbReq('POST','mealheiros',y.mealheiros.map(m=>({evento_id:eid,quem:m.quem,data:m.data||null,valor:m.valor,subtipo:m.subtipo||'lata',descricao:m.desc||''})));
    if(y.pagamentos&&y.pagamentos.length)
      await sbReq('POST','pagamentos',y.pagamentos.map(p=>({evento_id:eid,de:p.de,para:p.para,valor:p.valor,ref:p.ref||'',data:p.data||null,extra:p.extra||0})));
    // Propagar ids novos para o estado vivo (o replace recria todas as linhas)
    [ALL_YEARS[slot],(DATA&&DATA.evento&&DATA.evento.ano===ev.ano)?DATA:null].forEach(T=>{
      if(!T)return;
      if(idByNome&&T.membros)T.membros.forEach(m=>{if(idByNome[m.nome])m._id=idByNome[m.nome];});
      ['convidados','despesas'].forEach(k=>{
        if(T[k]&&y[k]&&T[k].length===y[k].length)T[k].forEach((row,i)=>{row._id=y[k][i]._id;});
      });
    });
    setSync('live','guardado · '+new Date().toLocaleTimeString('pt-PT',{hour:'2-digit',minute:'2-digit'}));
    return true;
  }catch(e){
    setSync('err','erro ao guardar');
    toast('Erro ao guardar: '+e.message,'bad');
    return false;
  }
}

/* ═══ HISTÓRICO — auditoria append-only (alimenta também a notificação Telegram) ═══ */
function sbLog(tipo,accao,alvo,detalhe){
  // Fire-and-forget: regista a ação na tabela 'historico'. Nunca bloqueia nem
  // faz falhar a ação principal. O Database Webhook do Telegram dispara daqui.
  // A frase em linguagem natural é construída AQUI e guardada na linha, para a
  // app e o Telegram mostrarem o mesmo texto sem duplicar lógica.
  try{
    if(!_sbSession||!DATA||!DATA._sbId)return;
    const autor=meuNomePrincipal()||null;
    const det=Object.assign({},detalhe||{});
    det.frase=fraseHistorico(tipo,accao,alvo,autor,det);
    sbReq('POST','historico',[{
      evento_id:DATA._sbId,
      autor_email:_sbSession.user.email,
      autor_amigo:autor,
      tipo,accao,alvo,
      detalhe:det
    }]).catch(()=>{});
  }catch(_){}
}

/* Redação das entradas do histórico (app + Telegram). */
function _diaNat(dia){
  const k=(dia||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().slice(0,3);
  const map={seg:['segunda','na'],ter:['terça','na'],qua:['quarta','na'],qui:['quinta','na'],sex:['sexta','na'],sab:['sábado','no'],dom:['domingo','no']};
  const e=map[k];return e?{nome:e[0],prep:e[1]}:{nome:dia||'',prep:'em'};
}
function _refNat(ref){
  const r=(ref||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  if(r.startsWith('alm'))return {noun:'almoço',verb:'almoçar'};
  if(r.startsWith('tar')||r.startsWith('lan'))return {noun:'lanche',verb:'lanchar'};
  return {noun:'jantar',verb:'jantar'};
}
function fraseHistorico(tipo,accao,alvo,autor,d){
  const A=autor||'Alguém';
  const dn=_diaNat(d.dia), rn=_refNat(d.ref);
  const diaStr=`${dn.prep} ${dn.nome}`;       // "na sexta"
  const refDia=`${rn.noun} de ${dn.nome}`;     // "jantar de sexta"
  if(tipo==='refeicao'){
    const papel=d.papel==='compras'?'pelas compras':'pela cozinha';
    if(accao==='retirou')return `${A} retirou ${alvo} de responsável ${papel} do ${refDia}`;
    return `${A} nomeou ${alvo} responsável ${papel} do ${refDia}`;
  }
  if(tipo==='compras'){
    const q=d.quantidade?` (${d.quantidade})`:'';
    const dest=d.dataValor?` para o ${refDia}`:'';
    return `${A} pôs "${alvo}"${q} na lista de compras${dest}${d.tratoEu?` — trata ${A}`:' — falta quem trate'}`;
  }
  if(tipo==='convidado'){
    const dono=(d.membro&&d.membro!==autor)?` (convidado de ${d.membro})`:'';
    if(accao==='removeu')return `${A} já não vai levar ${alvo} ao ${refDia}${dono}`;
    if(accao==='editou')return `${A} alterou o convidado ${alvo} no ${refDia}${dono}`;
    return `${A} vai levar ${alvo} ao ${refDia}${dono}`;
  }
  // presença: usa a transição origem(de) -> destino(para)
  const de=('de'in d)?d.de:undefined;
  const para=('para'in d)?d.para:(d.modo!==undefined?d.modo:undefined);
  const self=!!(autor&&alvo&&autor===alvo);
  const alvoTxt=self?'':` de ${alvo}`;
  // Sufixo com o total de pessoas a comer nesta refeição (só quem come),
  // acrescentado a todas as notificações de presença que enviamos.
  const tot=(d.totalCome!=null)?` — ${d.totalCome} a comer`:'';
  let f;
  if(de==null&&para==='come') f=`${A} confirmou presença${alvoTxt} no ${refDia}`;
  else if(de==null&&para==='bebe') f=self?`${A} confirmou que vai só beber ${diaStr}`:`${A} confirmou que ${alvo} vai só beber ${diaStr}`;
  else if(de==='come'&&para==='bebe') f=self?`${A} afinal só vai beber ${diaStr}`:`${A} mudou ${alvo} para só beber ${diaStr}`;
  else if(de==='bebe'&&para==='come') f=self?`${A} afinal vai ${rn.verb} ${diaStr}`:`${A} mudou ${alvo} para ${rn.verb} ${diaStr}`;
  else if(de==='come'&&para==null) f=self?`${A} afinal não vai ${rn.verb} ${diaStr}`:`${A} tirou ${alvo} do ${refDia}`;
  else if(de==='bebe'&&para==null) f=self?`${A} afinal não vai beber ${diaStr}`:`${A} cancelou a bebida${alvoTxt} ${diaStr}`;
  else if(para==null) f=self?`${A} saiu do ${refDia}`:`${A} tirou ${alvo} do ${refDia}`;
  else f=self?`${A} atualizou a presença no ${refDia}`:`${A} atualizou a presença de ${alvo} no ${refDia}`;
  return f+tot;
}

/* Log de presenças com debounce por célula: persiste-se cada toque na BD,
   mas só se regista no histórico a mudança LÍQUIDA após a pessoa assentar
   (~1.2s sem mais toques). Assim os estados de passagem obrigatórios do
   ciclo (come→bebe→vazio, bebe→vazio→come) não enchem o histórico, e voltar
   ao estado inicial não regista nada. */
const _presLogPend=new Map();   // key "membroId|dia|ref" -> {origem, final, alvo, dia, ref, timer}
function scheduleLogPresenca(m,dia,ref,origemTap,finalTap){
  const key=m._id+'|'+dia+'|'+ref;
  let e=_presLogPend.get(key);
  if(!e){e={origem:origemTap,alvo:m.nome,dia,ref,timer:null};_presLogPend.set(key,e);} // origem = estado antes da rajada
  e.final=finalTap;
  if(e.timer)clearTimeout(e.timer);
  e.timer=setTimeout(()=>_flushPresLog(key),2500);
}
/* Total de pessoas a comer numa refeição: membros com modo 'come' + convidados
   (que comem sempre). Reproduz o mapeamento Tarde→Lanche do rodapé da grelha,
   porque os convidados guardam a refeição do lanche como 'Lanche'. */
function totalComeRefeicao(dia,ref){
  const membros=(DATA&&DATA.membros)||[];
  const nMembros=membros.filter(m=>presModo(m,dia+'|'+ref)==='come').length;
  const refConv=(ref==='Tarde')?'Lanche':ref;
  const nConv=((DATA&&DATA.convidados)||[]).filter(g=>g.dia===dia&&g.ref===refConv).length;
  return nMembros+nConv;
}
function _flushPresLog(key){
  const e=_presLogPend.get(key);
  if(!e)return;
  if(e.timer)clearTimeout(e.timer);
  _presLogPend.delete(key);
  if(e.origem===e.final)return;                       // voltou ao mesmo -> nada a registar
  const accao=e.origem===null?'marcou':(e.final===null?'removeu':'mudou');
  const det={dia:e.dia,ref:e.ref,de:e.origem,para:e.final,totalCome:totalComeRefeicao(e.dia,e.ref)};
  // Transições de só-bebida ficam SEMPRE no histórico (auditoria), mas não
  // notificam: #2 (vazio→só bebe) e #6 (só bebe→vazio). A marca 'silencioso' é
  // lida pela Edge (notif-festas), que trava o envio. Para voltar a notificar
  // estas duas transições, comenta/remove a linha seguinte.
  if((e.origem===null&&e.final==='bebe')||(e.origem==='bebe'&&e.final===null))det.silencioso=true;
  sbLog('presenca',accao,e.alvo,det);
}
function flushPresLogs(){for(const k of [..._presLogPend.keys()])_flushPresLog(k);}

let _histRows=[];          // últimas linhas carregadas (filtradas em memória)
let _histFPessoa='all';    // filtro por pessoa (o visado da entrada = alvo)
let _histFRef='all';       // filtro por refeição (dia · ref)
function _histRefDe(r){const d=r.detalhe||{};return [d.dia,d.ref].filter(Boolean).join(' · ');}

async function openHistorico(){
  const el=document.getElementById('hist-list');
  if(!el)return;
  if(!_sbSession){el.innerHTML='<div class="note">Inicia sessão para ver o histórico.</div>';return;}
  if(!DATA||!DATA._sbId){el.innerHTML='<div class="note">Sem ano selecionado.</div>';return;}
  el.innerHTML='<div class="note">A carregar…</div>';
  try{
    const rows=await sbReq('GET',`historico?evento_id=eq.${DATA._sbId}&select=ts,autor_email,autor_amigo,tipo,accao,alvo,detalhe&order=ts.desc&limit=100`);
    el.dataset.loaded='1';
    _histRows=rows||[];
    renderHistList();
  }catch(e){
    el.innerHTML='<div class="note">Erro ao carregar histórico: '+escHtml(e.message||'')+'</div>';
  }
}

/* Desenha a lista já carregada (_histRows) aplicando os filtros por pessoa e
   por refeição. Os filtros correm em memória — não recarregam da BD. */
function renderHistList(){
  const el=document.getElementById('hist-list');
  if(!el)return;
  if(!_histRows.length){el.innerHTML='<div class="note">Ainda não há alterações registadas este ano.</div>';return;}
  // Opções dos dois filtros, a partir de todas as linhas carregadas
  const pessoas=[...new Set(_histRows.map(r=>r.alvo).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt'));
  const refs=[...new Set(_histRows.map(_histRefDe).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt'));
  if(_histFPessoa!=='all'&&!pessoas.includes(_histFPessoa))_histFPessoa='all';
  if(_histFRef!=='all'&&!refs.includes(_histFRef))_histFRef='all';
  const filtered=_histRows.filter(r=>
    (_histFPessoa==='all'||r.alvo===_histFPessoa)&&
    (_histFRef==='all'||_histRefDe(r)===_histFRef));
  // Barra de filtros
  let out='<div class="hist-filter">';
  out+=`<select onchange="_histFPessoa=this.value;renderHistList()"><option value="all"${_histFPessoa==='all'?' selected':''}>👤 Todas as pessoas</option>`+
    pessoas.map(p=>`<option value="${escHtml(p)}"${_histFPessoa===p?' selected':''}>${escHtml(p)}</option>`).join('')+'</select>';
  out+=`<select onchange="_histFRef=this.value;renderHistList()"><option value="all"${_histFRef==='all'?' selected':''}>🍽️ Todas as refeições</option>`+
    refs.map(p=>`<option value="${escHtml(p)}"${_histFRef===p?' selected':''}>${escHtml(p)}</option>`).join('')+'</select>';
  if(_histFPessoa!=='all'||_histFRef!=='all')out+=`<button class="hist-clear" onclick="_histFPessoa='all';_histFRef='all';renderHistList()">✕</button>`;
  out+='</div>';
  if(!filtered.length){el.innerHTML=out+'<div class="note">Sem alterações para este filtro.</div>';return;}
  out+=filtered.map(r=>{
      const d=r.detalhe||{};
      const quando=new Date(r.ts).toLocaleString('pt-PT',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
      const quem=escHtml(r.autor_amigo||r.autor_email||'?');
      const icon=r.tipo==='presenca'?'✋':r.tipo==='compras'?'🛒':r.tipo==='refeicao'?'🧑‍🍳':'👥';
      const slot=[d.dia,d.ref].filter(Boolean).join(' · ');
      let txt,sub;
      if(d.frase){
        txt=escHtml(d.frase);
        sub=quando;
      }else if(r.tipo==='presenca'){
        let ac,modo='';
        if(r.accao==='marcou'){ac='marcou presença de';if(d.modo==='bebe')modo=' (só bebida)';}
        else if(r.accao==='removeu'){ac='removeu presença de';}
        else{ac='mudou presença de';modo=d.modo==='bebe'?' (para só bebida)':' (para refeição completa)';}
        txt=`${ac} <b>${escHtml(r.alvo)}</b>${slot?' — '+escHtml(slot):''}${modo}`;
        sub=`${quem} · ${quando}`;
      }else{
        const ac=r.accao==='adicionou'?'adicionou convidado':r.accao==='removeu'?'removeu convidado':'editou convidado';
        const porQuem=d.membro?' (por '+escHtml(d.membro)+')':'';
        txt=`${ac} <b>${escHtml(r.alvo)}</b>${slot?' — '+escHtml(slot):''}${porQuem}`;
        sub=`${quem} · ${quando}`;
      }
      return `<div style="display:flex;gap:8px;padding:8px 0;border-bottom:1px solid var(--line)">
        <span style="flex-shrink:0">${icon}</span>
        <div style="flex:1;min-width:0;font-size:12.5px;line-height:1.4">
          <div style="color:var(--ink)">${txt}</div>
          <div style="font-size:11px;color:var(--faint);margin-top:2px">${sub}</div>
        </div>
      </div>`;
    }).join('');
  el.innerHTML=out;
}

function abrirHistoricoSeVazio(){
  const el=document.getElementById('hist-list');
  if(el&&el.dataset.loaded!=='1')openHistorico();
}

/* ═══ CASH FLOW MODAL ═══ */
let cfDir='reembolso';

function setCfType(t){
  cfDir=t;
  document.querySelectorAll('.cf-opt').forEach(el=>el.classList.toggle('on',el.dataset.cf===t));
  updateCfForm();
}

function memberOptions(sel){
  if(!CALC)return'<option value="">Seleciona…</option>';
  let o='<option value="">Seleciona…</option>';
  CALC.membros.forEach(m=>{o+=`<option value="${m.nome}"${sel===m.nome?' selected':''}>${m.nome}</option>`;});
  return o;
}

function updateCfForm(){
  const f=document.getElementById('cf-form');if(!f)return;
  const today=new Date().toISOString().slice(0,10);
  const tes=DATA?DATA.evento.tesoureiro:'';

  if(cfDir==='reembolso'){
    f.innerHTML=`
      <label>A quem reembolsaste?</label>
      <select id="cf-who">${memberOptions(myPrimaryName())}</select>
      <div class="inline-row" style="margin-top:14px">
        <div><label>Valor (€)</label><input type="number" id="cf-val" step="0.01" min="0.01" placeholder="0,00" inputmode="decimal"></div>
        <div><label>Data</label><input type="date" id="cf-date" value="${today}"></div>
      </div>
      <label>Descrição</label>
      <textarea id="cf-desc" placeholder="Opcional" rows="2"></textarea>`;
  } else if(cfDir==='despesa'){
    f.innerHTML=`
      <label>Quem pagou?</label>
      <select id="cf-who">${isAdmin()?memberOptions(myPrimaryName()):myMemberOptions(myPrimaryName())}</select>
      <div class="inline-row" style="margin-top:14px">
        <div><label>Tipo</label>
          <select id="cf-tipo" onchange="cfTipoChanged()">
            ${['Gerais','Bebidas','Almoço','Jantar','Renda','Cerveja'].map(t=>`<option value="${t}">${t}</option>`).join('')}
          </select>
        </div>
        <div><label>Valor (€)</label><input type="number" id="cf-val" step="0.01" min="0.01" placeholder="0,00" inputmode="decimal"></div>
      </div>
      <div class="cf-quando" id="cf-quando">
        <div class="cfq on" data-q="real" onclick="setCfQuando('cf','real')">📅 Com data</div>
        <div class="cfq" data-q="prevista" onclick="setCfQuando('cf','prevista')">📌 Prevista</div>
      </div>
      <div class="cf-quando-hint" id="cf-quando-hint">Despesa já realizada, com data conhecida.</div>
      <div id="cf-date-row" class="inline-row" style="margin-top:14px">
        <div><label>Data Despesa</label><input type="date" id="cf-date" value="${today}" oninput="cfSyncDataValor()"></div>
        <div><label>Data-Valor</label><input type="date" id="cf-date2" value=""></div>
      </div>
      <label>Descritivo <span class="cf-desc-count" id="cf-desc-count">0/30</span></label>
      <input type="text" id="cf-desc" placeholder="Ex: Continente — Bacalhau" maxlength="30" oninput="updDescCount('cf')">
      <label>Observações</label>
      <textarea id="cf-obs" placeholder="Detalhe adicional (opcional)" rows="2"></textarea>
      ${STOCK_TABLE?`<button class="btn ghost" style="width:100%;margin-top:14px" onclick="cfAbrirCompraFatura()">🧾 Itemizar / importar fatura →<span style="display:block;font-size:11px;font-weight:400;color:var(--muted);margin-top:2px;text-transform:none;letter-spacing:0">detalhar itens e alocar a refeições/tipos (stock)</span></button>`:''}`;
    setTimeout(cfTipoChanged,10);
  } else if(cfDir==='mealheiro'){
    f.innerHTML=`
      <label>Tipo de mealheiro</label>
      <div class="cf-wheel" id="meal-subtype-wheel" style="margin-bottom:4px">
        <div class="cf-opt on" data-sub="corrente" onclick="setMealSubtype(this,'corrente')"><span class="cf-icon" style="font-size:20px">${ICON_LATA}</span><span class="cf-lbl">Lata</span></div>
        <div class="cf-opt" data-sub="sobras" onclick="setMealSubtype(this,'sobras')"><span class="cf-icon" style="font-size:20px">${ICON_SACO}</span><span class="cf-lbl">Sobras Ano Ant.</span></div>
        <div class="cf-opt" data-sub="outros" onclick="setMealSubtype(this,'outros')"><span class="cf-icon" style="font-size:20px">${ICON_MOEDA}</span><span class="cf-lbl">Outros</span></div>
      </div>
      <div id="meal-corrente-fields">
        <label>Quem recolheu?</label>
        <select id="cf-who">${memberOptions(myPrimaryName()||tes)}</select>
        <div class="inline-row" style="margin-top:14px">
          <div><label>Valor (€)</label><input type="number" id="cf-val" step="0.01" min="0.01" placeholder="0,00" inputmode="decimal"></div>
          <div><label>Data</label><input type="date" id="cf-date" value="${today}"></div>
        </div>
      </div>
      <div id="meal-sobras-fields" style="display:none">
        <p style="font-size:12.5px;color:var(--muted);margin-top:8px;line-height:1.5">Regista o valor das sobras do ano anterior recebidas. Este valor é somado ao saldo inicial do grupo.</p>
        <label>Quem recebeu as sobras?</label>
        <select id="cf-who-sobras">${memberOptions(tes)}</select>
        <div class="inline-row" style="margin-top:14px">
          <div><label>Valor (€)</label><input type="number" id="cf-val-sobras" step="0.01" min="0.01" placeholder="0,00" inputmode="decimal"></div>
          <div><label>Data</label><input type="date" id="cf-date-sobras" value="${today}"></div>
        </div>
      </div>
      <div id="meal-outros-fields" style="display:none">
        <p style="font-size:12.5px;color:var(--muted);margin-top:8px;line-height:1.5">Regista entradas avulsas que reduzem a quota do grupo (ex: desconto t-shirts, patrocínios).</p>
        <label>Quem recebeu?</label>
        <select id="cf-who-outros">${memberOptions(tes)}</select>
        <label>Descrição</label>
        <textarea id="cf-desc-outros" placeholder="Ex: Desconto t-shirts, patrocínio..." rows="2"></textarea>
        <div class="inline-row" style="margin-top:14px">
          <div><label>Valor (€)</label><input type="number" id="cf-val-outros" step="0.01" min="0.01" placeholder="0,00" inputmode="decimal"></div>
          <div><label>Data</label><input type="date" id="cf-date-outros" value="${today}"></div>
        </div>
      </div>`;
  } else if(cfDir==='saldar'){
    f.innerHTML=`
      <label>Quem pagou?</label>
      <select id="cf-who" onchange="updateSdChips()">${memberOptions(myPrimaryName())}</select>
      <label>Que dívidas paga?</label>
      <div class="sd-list" id="sd-chips"></div>
      <div class="inline-row" style="margin-top:14px">
        <div><label>Valor (€)</label><input type="number" id="cf-val" step="0.01" min="0.01" placeholder="0,00" inputmode="decimal"></div>
        <div><label>Data</label><input type="date" id="cf-date" value="${today}"></div>
      </div>
      <div class="note" id="cf-val-hint"></div>
      <details class="cf-extra-box" id="cf-extra-box">
        <summary><span>🐖 Contribuição extra (poupança)</span><span class="chev">›</span></summary>
        <div class="cf-extra-body">
          <p class="note" style="margin-top:0">Raro. Usa quando alguém arredonda para cima — ex.: a dívida é 34€, entrega 35€; esse 1€ a mais entra na poupança do grupo e fica associado a este pagamento.</p>
          <label>Valor extra (€)</label>
          <input type="number" id="cf-extra" step="0.01" min="0" placeholder="0,00" inputmode="decimal" oninput="updateExtraTotal()">
          <div class="note" id="cf-total-hint"></div>
        </div>
      </details>`;
    setTimeout(updateSdChips,10);
  }
}

function cfTipoChanged(){
  if(isCfPrevista('cf'))return; // prevista: datas escondidas
  const tipo=document.getElementById('cf-tipo')?.value||'Gerais';
  const d2=document.getElementById('cf-date2');
  const d1=document.getElementById('cf-date');
  if(!d2||!d1)return;
  // Data-valor só é editável em Almoço/Jantar. Bebidas/Gerais → igual à data-despesa, bloqueado.
  const editavel=tipo==='Almoço'||tipo==='Jantar';
  if(editavel){
    d2.readOnly=false;d2.style.opacity='1';d2.style.pointerEvents='';
  }else{
    d2.value=d1.value;            // força igual à data-despesa
    d2.readOnly=true;d2.style.opacity='.55';d2.style.pointerEvents='none';
  }
}
function cfSyncDataValor(){
  const tipo=document.getElementById('cf-tipo')?.value||'Gerais';
  const d2=document.getElementById('cf-date2');
  const d1=document.getElementById('cf-date');
  if(!d2||!d1)return;
  // Gerais/Bebidas: data-valor segue sempre a data-despesa.
  // Almoço/Jantar: só preenche se ainda estiver vazia (não mexe se o user já a definiu).
  if(tipo==='Almoço'||tipo==='Jantar'){
    if(!d2.value)d2.value=d1.value;
  }else{
    d2.value=d1.value;
  }
}
function isCfPrevista(prefix){
  return document.querySelector(`#${prefix}-quando .cfq.on`)?.dataset?.q==='prevista';
}
function updDescCount(prefix){
  const inp=document.getElementById(`${prefix}-desc`);
  const c=document.getElementById(`${prefix}-desc-count`);
  if(!inp||!c)return;
  const n=inp.value.length;
  c.textContent=`${n}/30`;
  c.classList.toggle('full',n>=30);
}
function setCfQuando(prefix,q){
  document.querySelectorAll(`#${prefix}-quando .cfq`).forEach(el=>el.classList.toggle('on',el.dataset.q===q));
  const on=q==='prevista';
  const row=document.getElementById(`${prefix}-date-row`);
  const hint=document.getElementById(`${prefix}-quando-hint`);
  const d1=document.getElementById(`${prefix}-date`),d2=document.getElementById(`${prefix}-date2`);
  if(row)row.style.display=on?'none':'';
  if(hint)hint.textContent=on?'Despesa prevista — entra nas contas, mas ainda sem data de pagamento.':'Despesa já realizada, com data conhecida.';
  if(on){
    if(d1)d1.value='';
    if(d2)d2.value='';
  }else{
    if(d1&&!d1.value)d1.value=new Date().toISOString().slice(0,10);
    if(prefix==='cf')cfTipoChanged();else ecfTipoChanged();
  }
}

function ecfTipoChanged(){
  if(isCfPrevista('ecf'))return; // prevista: datas escondidas
  const tipo=document.getElementById('ecf-tipo')?.value||'Gerais';
  const d2=document.getElementById('ecf-date2');
  const d1=document.getElementById('ecf-date');
  if(!d2||!d1)return;
  const editavel=tipo==='Almoço'||tipo==='Jantar';
  if(editavel){
    d2.readOnly=false;d2.style.opacity='1';d2.style.pointerEvents='';
    if(!d2.value)d2.value=d1.value;
  }else{
    d2.value=d1.value;
    d2.readOnly=true;d2.style.opacity='.55';d2.style.pointerEvents='none';
  }
}
function ecfSyncDataValor(){
  const tipo=document.getElementById('ecf-tipo')?.value||'Gerais';
  const d2=document.getElementById('ecf-date2');
  const d1=document.getElementById('ecf-date');
  if(!d2||!d1)return;
  if(tipo==='Almoço'||tipo==='Jantar'){
    if(!d2.value)d2.value=d1.value;
  }else{
    d2.value=d1.value;
  }
}

function setMealSubtype(el, sub){
  document.querySelectorAll('#meal-subtype-wheel .cf-opt').forEach(e=>e.classList.toggle('on',e.dataset.sub===sub));
  document.getElementById('meal-corrente-fields').style.display = sub==='corrente' ? '' : 'none';
  document.getElementById('meal-sobras-fields').style.display = sub==='sobras' ? '' : 'none';
  document.getElementById('meal-outros-fields').style.display = sub==='outros' ? '' : 'none';
}

/* Adiantamentos de um membro = pagamentos "Pagar Dívida" SEM dívida associada (ref vazio).
   São genéricos (não presos a uma dívida específica), por isso abatem-se direto nas chips.
   NÃO inclui reembolsos (têm ref "Reembolso…") nem pagamentos saldar com dívida (ref own:/conv:). */
function _adiantamentosDe(nome){
  const pg=(CALC&&CALC.pagamentos)||[];
  return rnd(pg.filter(p=>p.de===nome && !(p.ref&&p.ref.trim())).reduce((a,p)=>a+(+p.valor||0),0),2);
}
/* Dívidas em aberto de um membro, já líquidas dos adiantamentos que fez.
   O adiantamento abate primeiro a dívida própria; o que sobrar abate a dos convidados. */
function _dividasEmAberto(m){
  const adiant=_adiantamentosDe(m.nome);
  let prop=Math.max(0,rnd(m.V-m.Y-m.W-m.X,2));
  let conv=Math.max(0,rnd(m.AA,2));
  const abP=Math.min(prop,adiant);
  prop=rnd(prop-abP,2);
  const resto=rnd(adiant-abP,2);
  conv=rnd(Math.max(0,conv-resto),2);
  return {prop,conv};
}

function updateSdChips(){
  if(!CALC)return;
  const container=document.getElementById('sd-chips');
  if(!container)return;
  const who=document.getElementById('cf-who')?.value||'';
  const ms=CALC.membros;
  // Only show members with active (unsettled) debts — saldoFinal < 0
  const debtors=ms.filter(m=>{
    if(m.saldoFinal>=- 0.005) return false; // already settled
    const d=_dividasEmAberto(m);
    return d.prop>0.005||d.conv>0.005;
  });

  if(!debtors.length){container.classList.remove('sd-grouped');container.innerHTML='<div class="empty sf" style="width:100%">Sem dívidas ativas por pagar</div>';recalcSdVal();return;}

  let mine='',other='',otherN=0;
  const rel=_relatedNames(who); // próprio/cônjuge = relativo a quem paga
  // Convidados primeiro, depois próprio — dentro de cada grupo
  debtors.forEach(m=>{
    const guestDebt=_dividasEmAberto(m).conv;
    const isDefault=m.nome===who;
    if(guestDebt>0.005){
      const chip=_sdChip('conv:'+m.nome,m.nome,true,guestDebt,isDefault,'toggleSdChip');
      if(rel.has(m.nome))mine+=chip;else{other+=chip;otherN++;}
    }
  });
  debtors.forEach(m=>{
    const ownDebt=_dividasEmAberto(m).prop;
    const isDefault=m.nome===who;
    if(ownDebt>0.005){
      const chip=_sdChip('own:'+m.nome,m.nome,false,ownDebt,isDefault,'toggleSdChip');
      if(rel.has(m.nome))mine+=chip;else{other+=chip;otherN++;}
    }
  });
  _sdRenderGroups(container,mine,other,otherN,false,true); // criação: "outros" sempre rotulado e colapsado
  recalcSdVal();
}

function toggleSdChip(el){el.classList.toggle('on');recalcSdVal();}

/* Helpers partilhados de chips de saldar (criação + edição) */
function _sdChip(key,nome,isConv,amt,isOn,handler,ro){
  const click=ro?'':` onclick="${handler}(this)"`;
  const amtHtml=amt>0.005?`<span class="sd-amt">${eur(amt)}</span>`:'';
  return `<div class="sd-chip${isOn?' on':''}${ro?' sd-ro':''}"${click} data-key="${key}">
    <span class="sd-dot"></span>${nome}${isConv?' <span style="font-size:10px;opacity:.6">conv.</span>':''}${amtHtml}</div>`;
}
/* Nomes "do próprio" relativos a quem paga: o próprio + cônjuge(s). */
function _relatedNames(payer){
  const s=new Set();
  if(payer)s.add(payer);
  CONJUGES.forEach(c=>{if(c.amigo_a===payer)s.add(c.amigo_b);if(c.amigo_b===payer)s.add(c.amigo_a);});
  return s;
}
function toggleSdGroup(hdr){const g=hdr.closest('.sd-other');if(g)g.classList.toggle('open');}
/* Renderiza chips separando próprio/cônjuge das dívidas de outros.
   openOther: secção "outros" aberta por omissão.
   labelOtherAlways: rotula "Dívidas de outros" mesmo sem grupo próprio
   (usado na consulta — sinaliza que este pagamento saldou dívidas de terceiros). */
function _sdRenderGroups(container,mine,other,otherN,openOther,labelOtherAlways){
  const useGroups=!!(mine&&other)||!!(other&&labelOtherAlways);
  if(!useGroups){container.classList.remove('sd-grouped');container.innerHTML=(mine||other);return;}
  container.classList.add('sd-grouped');
  let html='';
  if(mine)html+=`<div class="sd-group-lbl sf">Próprio e cônjuge</div><div class="sd-list">${mine}</div>`;
  html+=`<div class="sd-other${openOther?' open':''}">`+
    `<div class="sd-group-hdr sf" onclick="toggleSdGroup(this)"><span>Dívidas de outros<span class="sd-gn">${otherN}</span></span><span class="sd-chev">▾</span></div>`+
    `<div class="sd-list sd-other-body">${other}</div>`+
  `</div>`;
  container.innerHTML=html;
}

function recalcSdVal(){
  if(!CALC)return;
  const ms=CALC.membros;
  let total=0;
  const onChips=document.querySelectorAll('#sd-chips .sd-chip.on');
  onChips.forEach(chip=>{
    const key=chip.dataset.key;
    if(key.startsWith('own:')){
      const nome=key.slice(4);const m=ms.find(x=>x.nome===nome);
      if(m)total+=_dividasEmAberto(m).prop;
    } else if(key.startsWith('conv:')){
      const nome=key.slice(5);const m=ms.find(x=>x.nome===nome);
      if(m)total+=_dividasEmAberto(m).conv;
    }
  });
  total=rnd(total,2);
  const valEl=document.getElementById('cf-val');
  const hint=document.getElementById('cf-val-hint');
  if(valEl && total>0){
    valEl.value=total.toFixed(2);
    // If multiple chips selected, lock value to total (can't partial-pay multiple debts)
    if(onChips.length>1){
      valEl.readOnly=true;valEl.style.opacity='.6';
      if(hint)hint.textContent='Valor fixo (múltiplas dívidas selecionadas)';
    } else {
      valEl.readOnly=false;valEl.style.opacity='1';
      if(hint)hint.textContent='Podes ajustar o valor para pagamento parcial';
    }
  } else if(valEl){valEl.readOnly=false;valEl.style.opacity='1';if(hint)hint.textContent='Sem dívidas selecionadas — será registado como pagamento livre / adiantamento.';}
  updateExtraTotal();
}
// Atualiza só o aviso "Total a entregar" — NÃO mexe no campo Valor (preserva pagamentos parciais)
function updateExtraTotal(){
  const totalHint=document.getElementById('cf-total-hint');
  if(!totalHint)return;
  const extra=parseFloat(document.getElementById('cf-extra')?.value)||0;
  const base=parseFloat(document.getElementById('cf-val')?.value)||0;
  totalHint.textContent=extra>0?`Total a entregar: ${eur(rnd(base+extra,2))} (${eur(base)} dívida + ${eur(extra)} poupança)`:'';
}

function openPayModal(){
  document.getElementById('pay-bg').classList.add('show');
  document.body.classList.add('no-scroll');
  // Nº de colunas da grelha = tipos visíveis (não-admin só vê "Despesa")
  const wheel=document.getElementById('cf-wheel');
  if(wheel){
    const visiveis=[...wheel.querySelectorAll('.cf-opt')].filter(o=>getComputedStyle(o).display!=='none').length;
    wheel.style.setProperty('--cf-cols',Math.max(1,visiveis));
  }
  setCfType(contasFechadas()?'saldar':'despesa');
  const note=document.getElementById('cf-note');
  if(note)note.textContent=contasFechadas()?'Contas fechadas — só pagamentos de dívidas.':(isAdmin()?'Guardado na base de dados do grupo.':'Podes registar despesas pagas por ti ou pelo teu cônjuge.');
}
function closePayModal(){
  document.getElementById('pay-bg').classList.remove('show');
  document.body.classList.remove('no-scroll');
}

async function saveCashFlow(){
  if(contasFechadas()&&(cfDir==='despesa'||cfDir==='mealheiro')){toast('Contas fechadas — só pagamentos de dívidas','bad');return;}
  const who=document.getElementById('cf-who')?.value;
  const val=parseFloat(document.getElementById('cf-val')?.value);
  const date=document.getElementById('cf-date')?.value;
  // For mealheiro sobras, who/val come from separate fields — skip generic validation
  const mealSubCheck=cfDir==='mealheiro'&&(document.querySelector('#meal-subtype-wheel .cf-opt.on')?.dataset?.sub||'corrente')!=='corrente';
  if(!mealSubCheck){
    if(!who){toast('Seleciona a pessoa','bad');return;}
    if(!val||val<=0){toast('Valor inválido','bad');return;}
  }

  const tes=DATA.evento.tesoureiro;
  const desc=document.getElementById('cf-desc')?.value?.trim()||'';
  document.getElementById('pay-save').disabled=true;

  let commitMsg='';

  if(cfDir==='reembolso'){
    const ref=desc?`Reembolso: ${desc}`:'Reembolso';
    DATA.pagamentos.push({de:tes,para:who,valor:rnd(val,2),ref,data:date});
    commitMsg=`Reembolso: ${tes} → ${who} ${eur(val)}`;
  } else if(cfDir==='despesa'){
    const tipo=document.getElementById('cf-tipo')?.value||'Gerais';
    const prevista=isCfPrevista('cf');
    const obs=document.getElementById('cf-obs')?.value?.trim()||'';
    const descD=desc.slice(0,30);
    const date2=prevista?'':(document.getElementById('cf-date2')?.value||date);
    const dDesp=prevista?'':date;
    if(!isAdmin()&&!MY_NAMES.includes(who)){
      toast('Só podes registar despesas tuas ou do teu cônjuge','bad');
      document.getElementById('pay-save').disabled=false;return;
    }
    if(!DATA._sbId){toast('Sem ligação à base de dados — recarrega a página','bad');document.getElementById('pay-save').disabled=false;return;}
    setSync('load','a guardar…');
    try{
      const ins=await queueWrite(()=>sbReq('POST','despesas',
        [{evento_id:DATA._sbId,quem:who,data_desp:dDesp||null,data_valor:date2||null,descricao:descD||'(sem descrição)',tipo,valor:rnd(val,2),observacoes:obs||null}],
        {Prefer:'return=representation'}));
      DATA.despesas.push({_id:ins&&ins[0]?ins[0].id:null,quem:who,dataDesp:dDesp,dataValor:date2,desc:descD||'(sem descrição)',tipo,valor:rnd(val,2),obs,compraId:null});
      syncMirror();
      marcaGuardado();
      document.getElementById('pay-save').disabled=false;
      closePayModal();
      CALC=calcular(JSON.parse(JSON.stringify(DATA)));
      renderAll();
      toast('Despesa registada ✓','ok');
    }catch(e){
      setSync('err','erro ao guardar');
      document.getElementById('pay-save').disabled=false;
      toast(permErrorMsg(e),'bad');
    }
    return;
  } else if(cfDir==='mealheiro'){
    const mealSub=document.querySelector('#meal-subtype-wheel .cf-opt.on')?.dataset?.sub||'corrente';
    if(mealSub==='sobras'){
      const whoSobras=document.getElementById('cf-who-sobras')?.value;
      const valSobras=parseFloat(document.getElementById('cf-val-sobras')?.value);
      const dateSobras=document.getElementById('cf-date-sobras')?.value;
      if(!whoSobras){toast('Seleciona a pessoa','bad');document.getElementById('pay-save').disabled=false;return;}
      if(!valSobras||valSobras<=0){toast('Valor inválido','bad');document.getElementById('pay-save').disabled=false;return;}
      DATA.mealheiros.push({quem:whoSobras,data:dateSobras,valor:rnd(valSobras,2),subtipo:'sobras_ano_anterior'});
      commitMsg=`Sobras ano anterior: ${whoSobras} ${eur(valSobras)}`;
    } else if(mealSub==='outros'){
      const whoOutros=document.getElementById('cf-who-outros')?.value;
      const valOutros=parseFloat(document.getElementById('cf-val-outros')?.value);
      const dateOutros=document.getElementById('cf-date-outros')?.value;
      const descOutros=(document.getElementById('cf-desc-outros')?.value||'').trim();
      if(!whoOutros){toast('Seleciona a pessoa','bad');document.getElementById('pay-save').disabled=false;return;}
      if(!valOutros||valOutros<=0){toast('Valor inválido','bad');document.getElementById('pay-save').disabled=false;return;}
      DATA.mealheiros.push({quem:whoOutros,data:dateOutros,valor:rnd(valOutros,2),subtipo:'outros',desc:descOutros});
      commitMsg=`Outros: ${whoOutros} ${eur(valOutros)}${descOutros?' ('+descOutros+')':''}`;
    } else {
      DATA.mealheiros.push({quem:who,data:date,valor:rnd(val,2),subtipo:'lata'});
      commitMsg=`Lata: ${who} ${eur(val)}`;
    }
  } else if(cfDir==='saldar'){
    const covParts=[];
    document.querySelectorAll('#sd-chips .sd-chip.on').forEach(chip=>{covParts.push(chip.dataset.key);});
    if(!covParts.length){
      // Pagamento livre / adiantamento — ref fica vazio
      if(!confirm(`Sem dívidas selecionadas. Registar ${eur(val)} como pagamento livre / adiantamento de ${who}?`)){
        document.getElementById('pay-save').disabled=false;return;
      }
    }
    // If multiple chips selected, enforce total value (no partial across multiple debts)
    if(covParts.length>1){
      let expectedTotal=0;
      covParts.forEach(key=>{
        if(key.startsWith('own:')){const nome=key.slice(4);const m=CALC.membros.find(x=>x.nome===nome);if(m)expectedTotal+=_dividasEmAberto(m).prop;}
        else if(key.startsWith('conv:')){const nome=key.slice(5);const m=CALC.membros.find(x=>x.nome===nome);if(m)expectedTotal+=_dividasEmAberto(m).conv;}
      });
      expectedTotal=rnd(expectedTotal,2);
      if(Math.abs(val-expectedTotal)>0.01){toast('Com múltiplas dívidas, o valor tem de ser o total','bad');document.getElementById('pay-save').disabled=false;return;}
    }
    const extra=rnd(Math.max(0,parseFloat(document.getElementById('cf-extra')?.value)||0),2);
    const ref=covParts.join(', ');
    // p.valor = dinheiro real entregue (dívida + extra). p.extra = fatia que é poupança.
    DATA.pagamentos.push({de:who,para:tes,valor:rnd(val+extra,2),ref,data:date,extra});
    commitMsg=`Saldar: ${who} → ${tes} ${eur(rnd(val+extra,2))}`+(extra>0?` (poupança +${eur(extra)})`:'');
  }

  const ok=await pushToGitHub(commitMsg);
  document.getElementById('pay-save').disabled=false;
  if(ok){closePayModal();CALC=calcular(JSON.parse(JSON.stringify(DATA)));renderAll();toast('Cash-flow registado ✓','ok');}
}

/* ═══ EDIT / DELETE CASH FLOW ═══ */
let editingCf=null;

function openCfDetail(source,idx){
  // Cash-flow que veio de uma compra da lista → abre o editor da compra (não o de despesa avulsa)
  if(source==='despesas'){
    const d=DATA.despesas[idx];
    if(d&&d.compraId){openCompra(d.compraId);return;}
  }
  editCfEntry(source,idx);
  const et=editingCf&&editingCf.editType;
  // Pós-fecho: despesas e mealheiros (entradas de apuramento) ficam só de leitura; pagamentos continuam editáveis
  const bloquearPorFecho=contasFechadas()&&(et==='despesa'||et==='mealheiro');
  const mbtns=document.querySelector('#edit-cf-modal .mbtns');
  if(mbtns)mbtns.style.display=bloquearPorFecho?'none':'';
  if(!isAdmin()||bloquearPorFecho){
    const f=document.getElementById('edit-cf-form');
    f.querySelectorAll('input,select,textarea').forEach(el=>{el.disabled=true;el.style.opacity='.75';});
    f.querySelectorAll('.sd-chip,.cf-opt').forEach(el=>{el.style.pointerEvents='none';});
  }
}

function deleteCfFromDetail(){
  if(!editingCf)return;
  const{source,idx}=editingCf;
  if(!confirm('Tens a certeza que queres apagar este movimento?'))return;
  if(source==='pagamentos')DATA.pagamentos.splice(idx,1);
  else if(source==='despesas')DATA.despesas.splice(idx,1);
  else if(source==='mealheiros')DATA.mealheiros.splice(idx,1);
  closeEditCf();
  pushToGitHub('Remover cash-flow').then(ok=>{
    if(ok){CALC=calcular(JSON.parse(JSON.stringify(DATA)));renderAll();toast('Apagado ✓','ok');}
  });
}

function editCfEntry(source,idx){
  editingCf={source,idx};
  const f=document.getElementById('edit-cf-form');
  const title=document.getElementById('edit-cf-title');
  const wheel=document.getElementById('ecf-wheel');
  title.textContent='Detalhe Cash Flow';

  // Determine the type for this entry
  let editType='';
  if(source==='despesas') editType='despesa';
  else if(source==='mealheiros') editType='mealheiro';
  else if(source==='pagamentos'){
    const p=DATA.pagamentos[idx];
    editType=cfType(p);
  }
  editingCf.editType=editType;

  // Build wheel showing selected type (read-only highlight)
  const types=[
    {key:'reembolso',icon:'💸',label:'Reembolso'},
    {key:'despesa',icon:'🛒',label:'Despesa'},
    {key:'mealheiro',icon:'🐷',label:'Mealheiro'},
    {key:'saldar',icon:'🤝',label:'Pagar Dívida'}
  ];
  wheel.innerHTML=types.map(t=>`<div class="cf-opt${t.key===editType?' on':''}" style="pointer-events:none;opacity:${t.key===editType?'1':'.35'}"><span class="cf-icon">${t.icon}</span><span class="cf-lbl">${t.label}</span></div>`).join('');

  // Build form matching the creation layout for this type
  if(editType==='reembolso'){
    const p=DATA.pagamentos[idx];
    f.innerHTML=`
      <label>A quem reembolsaste?</label>
      <select id="ecf-who">${memberOptions(p.para)}</select>
      <div class="inline-row" style="margin-top:14px">
        <div><label>Valor (€)</label><input type="number" id="ecf-val" step="0.01" value="${p.valor}" inputmode="decimal"></div>
        <div><label>Data</label><input type="date" id="ecf-date" value="${p.data||''}"></div>
      </div>
      <label>Descrição</label>
      <textarea id="ecf-desc" rows="2">${(p.ref||'').replace(/^Reembolso:\s*/,'').replace(/^Reembolso$/,'')}</textarea>`;
  } else if(editType==='saldar'){
    const p=DATA.pagamentos[idx];
    // Parse existing ref to know which chips are selected
    const selectedKeys=(p.ref||'').split(/,\s*/).map(x=>x.trim()).filter(Boolean);
    const pExtra=+p.extra||0;
    const valDivida=rnd((+p.valor||0)-pExtra,2); // campo Valor mostra só a parte da dívida
    f.innerHTML=`
      <label>Quem pagou?</label>
      <select id="ecf-who" onchange="updateEditSdChips()">${memberOptions(p.de)}</select>
      <label>Que dívidas pagou?</label>
      <div class="sd-list" id="esd-chips"></div>
      <div class="inline-row" style="margin-top:14px">
        <div><label>Valor (€)</label><input type="number" id="ecf-val" step="0.01" value="${valDivida}" inputmode="decimal"></div>
        <div><label>Data</label><input type="date" id="ecf-date" value="${p.data||''}"></div>
      </div>
      <div class="note" id="ecf-val-hint"></div>
      <details class="cf-extra-box"${pExtra>0?' open':''}>
        <summary><span>🐖 Contribuição extra (poupança)</span><span class="chev">›</span></summary>
        <div class="cf-extra-body">
          <p class="note" style="margin-top:0">Fatia deste pagamento que vai para a poupança do grupo (ex.: arredondou a dívida para cima).</p>
          <label>Valor extra (€)</label>
          <input type="number" id="ecf-extra" step="0.01" min="0" value="${pExtra||''}" placeholder="0,00" inputmode="decimal">
        </div>
      </details>`;
    editingCf.selectedKeys=selectedKeys;
    setTimeout(()=>updateEditSdChips(),10);
  } else if(editType==='despesa'){
    const d=DATA.despesas[idx];
    const isPrev=!d.dataDesp&&!d.dataValor;
    f.innerHTML=`
      <label>Quem pagou?</label>
      <select id="ecf-who">${memberOptions(d.quem)}</select>
      <div class="inline-row" style="margin-top:14px">
        <div><label>Tipo</label>
          <select id="ecf-tipo" onchange="ecfTipoChanged()">
            ${['Gerais','Bebidas','Almoço','Jantar','Renda','Cerveja'].map(t=>`<option value="${t}"${t===d.tipo?' selected':''}>${t}</option>`).join('')}
          </select>
        </div>
        <div><label>Valor (€)</label><input type="number" id="ecf-val" step="0.01" value="${d.valor}" inputmode="decimal"></div>
      </div>
      <div class="cf-quando" id="ecf-quando">
        <div class="cfq${isPrev?'':' on'}" data-q="real" onclick="setCfQuando('ecf','real')">📅 Com data</div>
        <div class="cfq${isPrev?' on':''}" data-q="prevista" onclick="setCfQuando('ecf','prevista')">📌 Prevista</div>
      </div>
      <div class="cf-quando-hint" id="ecf-quando-hint">${isPrev?'Despesa prevista — entra nas contas, mas ainda sem data de pagamento.':'Despesa já realizada, com data conhecida.'}</div>
      <div id="ecf-date-row" class="inline-row" style="margin-top:14px${isPrev?';display:none':''}">
        <div><label>Data Despesa</label><input type="date" id="ecf-date" value="${d.dataDesp||''}" oninput="ecfSyncDataValor()"></div>
        <div><label>Data-Valor</label><input type="date" id="ecf-date2" value="${d.dataValor||''}"></div>
      </div>
      <label>Descritivo <span class="cf-desc-count" id="ecf-desc-count"></span></label>
      <input type="text" id="ecf-desc" maxlength="30" value="${escHtml((d.desc||'').slice(0,30))}" oninput="updDescCount('ecf')">
      <label>Observações</label>
      <textarea id="ecf-obs" rows="2" placeholder="Detalhe adicional (opcional)">${escHtml(d.obs||'')}</textarea>`;
    setTimeout(()=>{ecfTipoChanged();updDescCount('ecf');},10);
  } else if(editType==='mealheiro'){
    const m=DATA.mealheiros[idx];
    const st=m.subtipo||'lata';
    editingCf.mealSubtipo=st;
    f.innerHTML=`
      <label>Tipo de mealheiro</label>
      <div class="cf-wheel" id="ecf-meal-wheel" style="margin-bottom:4px">
        ${[['lata',ICON_LATA,'Lata'],['sobras_ano_anterior',ICON_SACO,'Sobras Ano Ant.'],['outros',ICON_MOEDA,'Outros']].map(([k,ic,lb])=>
          `<div class="cf-opt${k===st?' on':''}" onclick="setEcfMealSubtype(this,'${k}')"><span class="cf-icon" style="font-size:20px">${ic}</span><span class="cf-lbl">${lb}</span></div>`).join('')}
      </div>
      <label>Quem recebeu?</label>
      <select id="ecf-who">${memberOptions(m.quem)}</select>
      <label>Descrição</label>
      <textarea id="ecf-desc" rows="2" placeholder="Ex: Contagem da lata, patrocínio… (opcional)">${escHtml(m.desc||'')}</textarea>
      <div class="inline-row" style="margin-top:14px">
        <div><label>Valor (€)</label><input type="number" id="ecf-val" step="0.01" value="${m.valor}" inputmode="decimal"></div>
        <div><label>Data</label><input type="date" id="ecf-date" value="${m.data||''}"></div>
      </div>`;
  }

  applyRoFields(document.getElementById('edit-cf-modal'),!isAdmin());
  document.getElementById('edit-cf-bg').classList.add('show');
  document.body.classList.add('no-scroll');
}

/* Subtipo do mealheiro no modal de edição */
function setEcfMealSubtype(el,k){
  if(!editingCf)return;
  editingCf.mealSubtipo=k;
  document.querySelectorAll('#ecf-meal-wheel .cf-opt').forEach(o=>o.classList.toggle('on',o===el));
}

/* Detalhe de um pagamento: mostra SÓ as dívidas efetivamente pagas (consulta).
   Agrupa por relação com quem pagou; o bloco "Dívidas de outros" só aparece se
   este pagamento tiver realmente saldado dívidas de terceiros. */
function updateEditSdChips(){
  if(!CALC)return;
  const container=document.getElementById('esd-chips');
  if(!container)return;
  const who=document.getElementById('ecf-who')?.value||'';
  const ms=CALC.membros;
  const selKeys=editingCf?.selectedKeys||[];
  if(!selKeys.length){
    container.classList.remove('sd-grouped');
    container.innerHTML='<div class="empty sf" style="width:100%">Sem dívidas associadas — pagamento livre / adiantamento</div>';
    recalcEditSdVal(false);
    return;
  }
  const rel=_relatedNames(who); // próprio/cônjuge = relativo a quem pagou
  let mine='',other='',otherN=0;
  selKeys.forEach(key=>{
    const isConv=key.startsWith('conv:');
    const nome=isConv?key.slice(5):(key.startsWith('own:')?key.slice(4):key);
    const m=ms.find(x=>x.nome===nome);
    const amt=m?(isConv?_dividasEmAberto(m).conv:_dividasEmAberto(m).prop):0;
    const chip=_sdChip(key,nome,isConv,amt,true,'toggleEditSdChip'); // clicável: permite re-selecionar p/ recalcular o valor
    if(rel.has(nome))mine+=chip;else{other+=chip;otherN++;}
  });
  // "Dívidas de outros" (se existir) é a exceção → mostrar aberto
  _sdRenderGroups(container,mine,other,otherN,true,true);
  recalcEditSdVal(false); // ao abrir, NÃO reescrever o valor guardado
}
function toggleEditSdChip(el){
  el.classList.toggle('on');
  // Update selectedKeys
  if(editingCf){
    const keys=[];
    document.querySelectorAll('#esd-chips .sd-chip.on').forEach(c=>keys.push(c.dataset.key));
    editingCf.selectedKeys=keys;
  }
  recalcEditSdVal(true); // alteração explícita do utilizador → recalcular
}
function recalcEditSdVal(apply){
  if(!CALC)return;
  const ms=CALC.membros;
  let total=0;
  const onChips=document.querySelectorAll('#esd-chips .sd-chip.on');
  onChips.forEach(chip=>{
    const key=chip.dataset.key;
    if(key.startsWith('own:')){
      const nome=key.slice(4);const m=ms.find(x=>x.nome===nome);
      if(m)total+=_dividasEmAberto(m).prop;
    } else if(key.startsWith('conv:')){
      const nome=key.slice(5);const m=ms.find(x=>x.nome===nome);
      if(m)total+=_dividasEmAberto(m).conv;
    }
  });
  total=rnd(total,2);
  const valEl=document.getElementById('ecf-val');
  const hint=document.getElementById('ecf-val-hint');
  if(!valEl)return;
  if(onChips.length>1){
    if(apply)valEl.value=total.toFixed(2);
    valEl.readOnly=true;valEl.style.opacity='.6';
    if(hint)hint.textContent='Valor fixo (múltiplas dívidas selecionadas)';
  } else if(onChips.length===1){
    if(apply)valEl.value=total.toFixed(2);
    valEl.readOnly=false;valEl.style.opacity='1';
    if(hint)hint.textContent='Podes ajustar o valor para pagamento parcial';
  } else {
    // Pagamento livre / adiantamento — manter o valor guardado
    valEl.readOnly=false;valEl.style.opacity='1';
    if(hint)hint.textContent='💡 Pagamento livre / adiantamento — sem dívida associada. O valor fica como crédito da pessoa.';
  }
}

function closeEditCf(){
  document.getElementById('edit-cf-bg').classList.remove('show');
  document.body.classList.remove('no-scroll');
  editingCf=null;
}

async function saveEditCf(){
  if(!editingCf)return;
  const{source,idx,editType}=editingCf;
  document.getElementById('edit-cf-save').disabled=true;

  if(source==='pagamentos'){
    const p=DATA.pagamentos[idx];
    const tes=DATA.evento.tesoureiro;
    if(editType==='reembolso'){
      p.para=document.getElementById('ecf-who').value;
      p.de=tes;
      p.valor=parseFloat(document.getElementById('ecf-val').value)||p.valor;
      p.data=document.getElementById('ecf-date').value;
      const desc=(document.getElementById('ecf-desc')?.value||'').trim();
      p.ref=desc?`Reembolso: ${desc}`:'Reembolso';
    } else if(editType==='saldar'){
      p.de=document.getElementById('ecf-who').value;
      p.para=tes;
      const valDivida=parseFloat(document.getElementById('ecf-val').value);
      const extra=rnd(Math.max(0,parseFloat(document.getElementById('ecf-extra')?.value)||0),2);
      const base=isNaN(valDivida)?rnd((+p.valor||0)-(+p.extra||0),2):valDivida;
      p.valor=rnd(base+extra,2);
      p.extra=extra;
      p.data=document.getElementById('ecf-date').value;
      const covParts=[];
      document.querySelectorAll('#esd-chips .sd-chip.on').forEach(chip=>{covParts.push(chip.dataset.key);});
      p.ref=covParts.join(', ');
    }
  } else if(source==='despesas'){
    const d=DATA.despesas[idx];
    const prevista=isCfPrevista('ecf');
    d.quem=document.getElementById('ecf-who').value;
    d.dataDesp=prevista?'':document.getElementById('ecf-date').value;
    d.dataValor=prevista?'':document.getElementById('ecf-date2').value;
    d.tipo=document.getElementById('ecf-tipo').value;
    d.valor=parseFloat(document.getElementById('ecf-val').value)||d.valor;
    d.desc=(document.getElementById('ecf-desc')?.value||'').trim().slice(0,30);
    d.obs=(document.getElementById('ecf-obs')?.value||'').trim();
  } else if(source==='mealheiros'){
    const m=DATA.mealheiros[idx];
    m.quem=document.getElementById('ecf-who').value;
    m.valor=parseFloat(document.getElementById('ecf-val').value)||m.valor;
    m.data=document.getElementById('ecf-date').value;
    m.subtipo=editingCf.mealSubtipo||m.subtipo||'lata';
    m.desc=(document.getElementById('ecf-desc')?.value||'').trim();
  }

  const ok=await pushToGitHub('Editar cash-flow');
  document.getElementById('edit-cf-save').disabled=false;
  if(ok){closeEditCf();CALC=calcular(JSON.parse(JSON.stringify(DATA)));renderAll();toast('Editado ✓','ok');}
}

/* ADMIN */
function toggleSettingsBlock(hdr){
  hdr.classList.toggle('open');
  const body=hdr.nextElementSibling;
  body.classList.toggle('open');
}
function openAdmin(){
  const em=document.getElementById('adm-conta-email');
  if(em)em.textContent=_sbSession?_sbSession.user.email:'—';
  const ver=document.getElementById('adm-versao');
  if(ver)ver.textContent='Versão '+APP_BUILD;
  const adm=document.getElementById('adm-pedidos-wrap');
  if(adm)adm.style.display=isAdmin()?'':'none';
  if(isAdmin()){sbRenderPedidos();sbRenderLigacoes();loadNotif();admCatCancel();renderAdmCats();}
  loadMyNotif();
  loadParams();
  renderPlantel();
  loadLimpeza();
  document.getElementById('admin-bg').classList.add('show');
  document.body.classList.add('no-scroll');
}
function closeAdmin(){document.getElementById('admin-bg').classList.remove('show');document.body.classList.remove('no-scroll');}


/* ── Parametrizações ── */
function loadParams(){
  if(!DATA)return;
  document.getElementById('adm-params-year').textContent=DATA.evento.ano||'';
  const arredonda=DATA.evento.arredondaTotal||false;
  const missao=DATA.evento.missaoPoupanca||0;
  const fundo=DATA.evento.fundoReserva||0;
  document.getElementById('adm-arredonda').checked=arredonda;
  updateToggleKnob(arredonda);
  const dpRow=document.getElementById('adm-divpub-row');
  if(dpRow){
    dpRow.style.display=DATA.evento.dividasPublicasCol?'':'none';
    document.getElementById('adm-divpub').checked=!!DATA.evento.dividasPublicas;
    _setDivpubKnob(!!DATA.evento.dividasPublicas);
  }
  document.getElementById('adm-missao').value=missao||'';
  document.getElementById('adm-fundo').value=fundo||'';
  const fmEl=document.getElementById('adm-fator-modo');
  if(fmEl)fmEl.value=DATA.evento.fatorModo||'fixo';
  const ftEl=document.getElementById('adm-fator-thr');
  if(ftEl)ftEl.value=Math.round(((DATA.evento.fatorThreshold!=null?DATA.evento.fatorThreshold:FATOR_THRESHOLD_DEFAULT))*100);
  _syncThrLock();
}
function _syncThrLock(){
  const fm=document.getElementById('adm-fator-modo');
  const ft=document.getElementById('adm-fator-thr');
  if(!fm||!ft)return;
  const off=fm.value!=='variavel';
  ft.disabled=off;
  ft.style.opacity=off?'.45':'';
  ft.style.cursor=off?'not-allowed':'';
}
function updateToggleKnob(on){
  const knob=document.getElementById('adm-arredonda-knob');
  const track=knob?.previousElementSibling;
  if(knob){knob.style.left=on?'22px':'2px';}
  if(track){track.style.background=on?'var(--gold)':'var(--line)';}
}
function _setDivpubKnob(on){
  const knob=document.getElementById('adm-divpub-knob');
  const track=knob?.previousElementSibling;
  if(knob)knob.style.left=on?'22px':'2px';
  if(track)track.style.background=on?'var(--gold)':'var(--line)';
}
/* ── Notificações Telegram (só admin · flag global em festasbv.config) ── */
function _setNotifKnob(on){
  const knob=document.getElementById('adm-notif-knob');
  const track=knob?.previousElementSibling;
  if(knob)knob.style.left=on?'22px':'2px';
  if(track)track.style.background=on?'var(--gold)':'var(--line)';
}
async function loadNotif(){
  const cb=document.getElementById('adm-notif');if(!cb)return;
  try{
    const rows=await sbReq('GET','config?chave=eq.notif_telegram&select=valor');
    const on=Array.isArray(rows)&&rows[0]?(rows[0].valor==='true'):true;
    cb.checked=on;_setNotifKnob(on);
  }catch(_){cb.checked=true;_setNotifKnob(true);}
}
async function saveNotif(){
  const cb=document.getElementById('adm-notif');if(!cb)return;
  const on=cb.checked;_setNotifKnob(on);
  try{
    await sbReq('PATCH','config?chave=eq.notif_telegram',{valor:on?'true':'false'});
    toast(on?'Notificações ligadas ✓':'Notificações desligadas ✓','ok');
  }catch(e){
    cb.checked=!on;_setNotifKnob(!on);   // reverte o visual se a gravação falhar
    toast('Erro ao guardar: '+e.message,'bad');
  }
}

/* ── Notificações Telegram PESSOAIS (cada utilizador · festasbv.notif_prefs) ──
   Fluxo de ligação: a app gera um código, o utilizador toca em
   t.me/<bot>?start=<codigo> e a Edge Function notif-pessoais (webhook do bot)
   guarda o chat_id. A partir daí recebe avisos dirigidos a ele (responsável
   de refeição, artigos de compras por tratar). */
let _myNotif=null;   // linha própria de notif_prefs (null = ainda sem registo)
let _tgBot='';       // username do bot (config 'telegram_bot', sem @)
async function loadMyNotif(){
  const el=document.getElementById('my-notif-body');if(!el)return;
  if(!_sbSession){el.innerHTML='<div class="note">Inicia sessão para configurar as notificações.</div>';return;}
  el.innerHTML='<div class="note">A carregar…</div>';
  try{
    const [rows,cfg]=await Promise.all([
      sbReq('GET',`notif_prefs?user_email=eq.${enc(_sbSession.user.email)}&select=*`),
      sbReq('GET','config?chave=eq.telegram_bot&select=valor').catch(()=>null)
    ]);
    _myNotif=rows&&rows[0]?rows[0]:null;
    _tgBot=cfg&&cfg[0]?(cfg[0].valor||'').replace(/^@/,''):'';
    renderMyNotif();
  }catch(e){
    el.innerHTML='<div class="note">Notificações pessoais indisponíveis — falta correr a migração <b>db/notifs.sql</b> no Supabase.</div>';
  }
}
function _notifCodigo(){
  const a='abcdefghijklmnopqrstuvwxyz0123456789';let s='';
  crypto.getRandomValues(new Uint8Array(10)).forEach(v=>s+=a[v%36]);
  return s;
}
async function ensureMyNotif(){   // cria a linha (com código de ligação) na 1ª utilização
  if(_myNotif)return _myNotif;
  const row={user_email:_sbSession.user.email,codigo:_notifCodigo(),ativo:true};
  const ins=await sbReq('POST','notif_prefs',[row],{Prefer:'return=representation'});
  _myNotif=ins&&ins[0]?ins[0]:row;
  return _myNotif;
}
async function ligarTelegram(){
  try{
    const p=await ensureMyNotif();
    renderMyNotif();
    if(!_tgBot){toast('O admin ainda não configurou o bot (config → telegram_bot)','bad');return;}
    window.open(`https://t.me/${_tgBot}?start=${enc(p.codigo)}`,'_blank');
  }catch(e){toast(permErrorMsg(e),'bad');}
}
function copyStartCmd(){
  if(!_myNotif||!_myNotif.codigo)return;
  const cmd='/start '+_myNotif.codigo;
  const done=()=>toast('Copiado — cola no chat do bot ✓','ok');
  if(navigator.clipboard&&navigator.clipboard.writeText){
    navigator.clipboard.writeText(cmd).then(done).catch(()=>toast(cmd,'ok'));
  }else toast(cmd,'ok');   // sem clipboard API: mostra o comando para copiar à mão
}
async function toggleMyNotif(cb){
  const on=cb.checked;
  try{
    await ensureMyNotif();
    await sbReq('PATCH',`notif_prefs?user_email=eq.${enc(_sbSession.user.email)}`,{ativo:on,updated_at:new Date().toISOString()});
    _myNotif.ativo=on;renderMyNotif();
    toast(on?'Notificações pessoais ligadas ✓':'Notificações pessoais desligadas ✓','ok');
  }catch(e){cb.checked=!on;renderMyNotif();toast(permErrorMsg(e),'bad');}
}
function renderMyNotif(){
  const el=document.getElementById('my-notif-body');if(!el)return;
  const ligado=!!(_myNotif&&_myNotif.chat_id);
  const ativo=_myNotif?!!_myNotif.ativo:true;
  const status=ligado
    ?'<span style="color:var(--green,#2f9e63);font-weight:700">✅ Telegram ligado</span>'
    :(_myNotif?'⏳ Falta concluir a ligação no Telegram':'📴 Telegram ainda não ligado');
  let h=`<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--panel2);border:1px solid var(--line);border-radius:10px">
    <div style="flex:1">
      <div style="font-size:13px;font-weight:600">Receber avisos no Telegram</div>
      <div style="font-size:11px;color:var(--faint);line-height:1.4">${status}</div>
    </div>
    <label style="position:relative;width:44px;height:24px;margin:0;flex-shrink:0">
      <input type="checkbox" onchange="toggleMyNotif(this)" ${ativo?'checked':''} style="opacity:0;width:0;height:0;position:absolute">
      <span style="position:absolute;inset:0;background:${ativo?'var(--gold)':'var(--line)'};border-radius:12px;cursor:pointer;transition:.2s"></span>
      <span style="position:absolute;top:2px;left:${ativo?'22px':'2px'};width:20px;height:20px;background:var(--ink);border-radius:50%;transition:.2s"></span>
    </label>
  </div>`;
  if(!ligado){
    h+=`<div class="note" style="margin-top:10px;line-height:1.6">Para ligares:<br>
      1. Toca em <b>Ligar ao Telegram</b> (abre o bot já com o teu código)<br>
      2. No Telegram, toca em <b>Começar/Start</b><br>
      3. Volta aqui e toca em <b>Verificar</b> — deve aparecer ✅</div>
    <div class="mbtns" style="margin-top:10px">
      <button class="btn" onclick="loadMyNotif()">🔄 Verificar</button>
      <button class="btn prim" onclick="ligarTelegram()">📲 Ligar ao Telegram</button>
    </div>`;
    // Plano B: o deep-link do Telegram nem sempre envia o código (sobretudo em
    // conversas já abertas com o bot) — mostra o comando pronto a copiar.
    if(_myNotif&&_myNotif.codigo){
      h+=`<div class="note" style="margin-top:10px">Se o bot não responder "✅ Ligado!", envia-lhe esta mensagem${_tgBot?` (@${escHtml(_tgBot)})`:''}:</div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <code style="flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 12px;font-size:13px;user-select:all;overflow-x:auto;white-space:nowrap">/start ${escHtml(_myNotif.codigo)}</code>
        <button class="btn" style="flex-shrink:0" onclick="copyStartCmd()">📋 Copiar</button>
      </div>`;
    }
    if(!_tgBot)h+='<div class="note">⚠️ O bot ainda não está configurado (o admin tem de preencher <b>telegram_bot</b> na config).</div>';
  }else{
    h+='<div class="note" style="margin-top:8px">Recebes avisos quando fores nomeado responsável de uma refeição, quando mudam presenças/convidados de uma refeição tua, e quando alguém põe um artigo nas compras sem ficar a tratar dele.</div>';
  }
  el.innerHTML=h;
}
async function saveParams(){
  if(!DATA)return;
  const arredonda=document.getElementById('adm-arredonda').checked;
  updateToggleKnob(arredonda);
  DATA.evento.arredondaTotal=arredonda;
  if(DATA.evento.dividasPublicasCol){
    const dp=document.getElementById('adm-divpub').checked;
    _setDivpubKnob(dp);
    DATA.evento.dividasPublicas=dp;
  }
  DATA.evento.missaoPoupanca=parseFloat(document.getElementById('adm-missao').value)||0;
  DATA.evento.fundoReserva=parseFloat(document.getElementById('adm-fundo').value)||0;
  const fmEl=document.getElementById('adm-fator-modo');
  if(fmEl)DATA.evento.fatorModo=(fmEl.value==='variavel')?'variavel':'fixo';
  _syncThrLock();
  const ftEl=document.getElementById('adm-fator-thr');
  if(ftEl){let p=parseFloat(ftEl.value);if(isNaN(p))p=70;p=Math.min(100,Math.max(0,p));DATA.evento.fatorThreshold=rnd(p/100,2);}
  const ok=await pushToGitHub('Atualizar parametrizações '+DATA.evento.ano);
  if(ok){
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();
    toast('Parametrizações guardadas ✓','ok');
  }
}

/* ── Limpeza (só admin · ano aberto · até à 1ª refeição) ── */
function _hojeISO(){const d=new Date();const z=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+z(d.getMonth()+1)+'-'+z(d.getDate());}
function _limpezaPermitida(){
  if(!DATA||!DATA.evento)return{ok:false,motivo:'Sem dados carregados.'};
  if(!isAdmin())return{ok:false,motivo:'Apenas o tesoureiro/admin pode fazer reset.'};
  if(DATA.evento.contasFechadas)return{ok:false,motivo:'As contas deste ano estão fechadas.'};
  const datas=(DATA.refeicoesDef||[]).map(r=>r.data).filter(Boolean).sort();
  if(datas.length){
    const first=datas[0];
    if(_hojeISO()>first)return{ok:false,motivo:'Já passou a 1ª refeição ('+first+') — reset bloqueado.'};
  }
  return{ok:true,motivo:''};
}
function loadLimpeza(){
  if(!DATA)return;
  const yEl=document.getElementById('adm-limpeza-year');if(yEl)yEl.textContent=DATA.evento.ano||'';
  const p=_limpezaPermitida();
  ['btn-limpar-presencas','btn-limpar-cashflows','btn-limpar-compras'].forEach(id=>{
    const b=document.getElementById(id);if(!b)return;
    b.disabled=!p.ok;b.style.opacity=p.ok?'':'.4';b.style.cursor=p.ok?'pointer':'not-allowed';
  });
  const av=document.getElementById('adm-limpeza-aviso');
  if(av){av.style.display=p.ok?'none':'block';av.textContent=p.ok?'':('🔒 '+p.motivo);}
}
async function limparPresencas(){
  const p=_limpezaPermitida();if(!p.ok){toast(p.motivo,'bad');return;}
  const ano=DATA.evento.ano;
  const nPres=(DATA.membros||[]).reduce((a,m)=>a+((m.presencas||[]).length),0);
  const nConv=(DATA.convidados||[]).length;
  // contar linhas de histórico do ano (para o aviso e para saber se há algo a limpar)
  let nHist=0;
  try{const hr=await sbReq('GET',`historico?evento_id=eq.${DATA._sbId}&select=ts`);nHist=Array.isArray(hr)?hr.length:0;}catch(_){}
  if(!nPres&&!nConv&&!nHist){toast('Não há presenças, convidados nem histórico para reset em '+ano,'ok');return;}
  if(!confirm('RESET PRESENÇAS — '+ano+'\n\nVai apagar '+nPres+' presença(s), '+nConv+' convidado(s) e '+nHist+' registo(s) de histórico.\nMembros, fator e sexo mantêm-se.\n\nSó afeta o ano '+ano+'. Esta ação NÃO pode ser desfeita.\n\nConfirmar?'))return;
  (DATA.membros||[]).forEach(m=>{m.presencas=[];});
  DATA.convidados=[];
  const ok=await pushToGitHub('Reset presenças e convidados '+ano);
  if(ok){
    try{await sbReq('DELETE',`historico?evento_id=eq.${DATA._sbId}`);}catch(_){}   // limpa também o histórico do ano
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));renderAll();loadLimpeza();toast('Presenças e histórico de '+ano+' repostos ✓','ok');
  }
  else loadLimpeza();
}
/* Sobras do ano anterior → entrada de mealheiro 'sobras_ano_anterior' para o ano dado.
   Fonte: saldo sobrante (saldoGrupo) do ano imediatamente anterior existente. Devolve null se
   não houver ano anterior ou se o saldo não for positivo. Reutilizado por addNewYear e
   limparCashflows (que a regenera caso já não exista). */
function _sobrasAnoAnterior(ano,tesoureiro){
  const prev=ALL_YEARS.filter(y=>(y.evento.ano||0)<ano).sort((a,b)=>(a.evento.ano||0)-(b.evento.ano||0)).pop();
  if(!prev)return null;
  const sobras=rnd(calcular(JSON.parse(JSON.stringify(prev))).saldoGrupo||0,2);
  if(sobras<=0)return null;
  return{quem:tesoureiro,data:ano+'-01-01',valor:sobras,subtipo:'sobras_ano_anterior',desc:'Sobras ano anterior ('+prev.evento.ano+')'};
}
async function limparCashflows(){
  const p=_limpezaPermitida();if(!p.ok){toast(p.motivo,'bad');return;}
  const ano=DATA.evento.ano;
  // Sobras do ano anterior são transitadas e NÃO se apagam no reset.
  const isSobras=m=>m&&m.subtipo==='sobras_ano_anterior';
  const mealDel=(DATA.mealheiros||[]).filter(m=>!isSobras(m));
  let mealKeep=(DATA.mealheiros||[]).filter(isSobras);
  // Validar sempre o trânsito das sobras do ano anterior. Se não houver nenhuma registada
  // (ex.: apagada por um reset feito antes desta automação), regenera-a do saldo do ano anterior.
  const tinhaSobras=mealKeep.length>0;
  if(!tinhaSobras){const s=_sobrasAnoAnterior(ano,DATA.evento.tesoureiro);if(s)mealKeep=[s];}
  const regenerou=!tinhaSobras&&mealKeep.length>0;
  const nDesp=(DATA.despesas||[]).length,nMeal=mealDel.length,nPag=(DATA.pagamentos||[]).length;
  const temParaLimpar=nDesp||nMeal||nPag;

  // Sem cash-flows para apagar: mesmo assim garante-se a entrada de sobras do ano anterior.
  if(!temParaLimpar){
    if(!regenerou){toast('Não há cash-flows para reset em '+ano,'ok');return;}
    if(!confirm('SOBRAS DO ANO ANTERIOR — '+ano+'\n\nNão há cash-flows para reset, mas falta a entrada de sobras do ano anterior ('+eur(mealKeep[0].valor)+'). Repor?'))return;
    DATA.mealheiros=mealKeep;
    const okS=await pushToGitHub('Repor sobras do ano anterior '+ano);
    if(okS){CALC=calcular(JSON.parse(JSON.stringify(DATA)));renderAll();loadLimpeza();toast('Sobras do ano anterior repostas ✓','ok');}
    else loadLimpeza();
    return;
  }

  const avisoSobras=mealKeep.length?('\n\n('+(tinhaSobras?'Mantêm-se':'Transitam-se')+' '+mealKeep.length+' sobra(s) do ano anterior — não se apagam.)'):'';
  if(!confirm('RESET CASH-FLOWS — '+ano+'\n\nVai apagar:\n· '+nDesp+' despesa(s)\n· '+nMeal+' mealheiro(s)\n· '+nPag+' pagamento(s)/reembolso(s)'+avisoSobras+'\n\nSó afeta o ano '+ano+'. Esta ação NÃO pode ser desfeita.\n\nConfirmar?'))return;
  // Repor na lista os artigos que estavam "comprados" (as despesas vão desaparecer;
  // sem isto ficariam órfãos). A rede de segurança no cliente já os mostraria como
  // pendentes, mas aqui limpa-se também o estado na BD.
  const boughtIds=(DATA.shoplist||[]).filter(x=>x.estado==='comprado'&&x._id!=null).map(x=>x._id);
  if(boughtIds.length){
    try{
      await queueWrite(()=>sbReq('PATCH',`shoplist?id=in.(${boughtIds.join(',')})`,{estado:'pendente',compra_id:null,cf_desc:null,comprado_em:null}));
      DATA.shoplist.forEach(it=>{if(it.estado==='comprado')Object.assign(it,{estado:'pendente',compraId:null,cfDesc:null,compradoEm:null});});
    }catch(e){toast('Aviso: artigos da lista não repostos — '+e.message,'bad');}
  }
  DATA.despesas=[];DATA.mealheiros=mealKeep;DATA.pagamentos=[];
  const ok=await pushToGitHub('Reset cash-flows '+ano);
  if(ok){CALC=calcular(JSON.parse(JSON.stringify(DATA)));renderAll();loadLimpeza();toast('Cash-flows de '+ano+' repostos ✓','ok');}
  else loadLimpeza();
}
async function limparCompras(){
  const p=_limpezaPermitida();if(!p.ok){toast(p.motivo,'bad');return;}
  const ano=DATA.evento.ano;
  const items=(DATA.shoplist||[]);
  const n=items.length;
  if(!n){toast('Não há artigos na lista de compras para reset em '+ano,'ok');return;}
  const nComp=items.filter(x=>x.estado==='comprado').length;
  // shoplist vive só no Supabase (não vai no JSON do GitHub) — apaga por evento.
  // Artigos já comprados têm despesas associadas que se mantêm: essas limpam-se
  // em "Reset cash-flows". Aqui só se esvazia a lista de compras.
  const aviso=nComp?('\n· '+nComp+' já comprado(s) — as despesas associadas mantêm-se (usa "Reset cash-flows" para essas).'):'';
  if(!confirm('RESET LISTAS DE COMPRAS — '+ano+'\n\nVai apagar '+n+' artigo(s) da lista de compras.'+aviso+'\n\nSó afeta o ano '+ano+'. Esta ação NÃO pode ser desfeita.\n\nConfirmar?'))return;
  setSync('load','a guardar…');
  try{
    await queueWrite(()=>sbReq('DELETE',`shoplist?evento_id=eq.${DATA._sbId}`));
    DATA.shoplist=[];syncMirror();marcaGuardado();renderAll();loadLimpeza();
    toast('Lista de compras de '+ano+' reposta ✓','ok');
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');loadLimpeza();}
}

/* ── Add New Year ── */
let NY_MEMBROS=[];   // plantel em preparação para o novo ano

function nyRender(){
  const list=document.getElementById('ny-plantel-list');
  if(!NY_MEMBROS.length){
    list.innerHTML='<div class="empty sf">Sem membros — copia o plantel ou adiciona abaixo</div>';
  }else{
    let h='';
    NY_MEMBROS.forEach((m,i)=>{
      h+=`<div class="pl-item">
        <span class="pl-name">${m.nome}</span>
        <span class="pl-fator"><input type="number" value="${m.fator}" step="0.05" min="0" onchange="nyUpdateFator(${i},this.value)" title="Fator"></span>
        <button class="pl-del" onclick="nyRemoveMember(${i})" title="Remover">✕</button>
      </div>`;
    });
    list.innerHTML=h;
  }
  // Tesoureiro: dropdown alimentado pelos membros em preparação
  const sel=document.getElementById('adm-new-tes');
  const prev=sel.value;
  let o='<option value="">— escolhe um membro —</option>';
  NY_MEMBROS.forEach(m=>{o+=`<option value="${m.nome}"${prev===m.nome?' selected':''}>${m.nome}</option>`;});
  sel.innerHTML=o;
  if(prev&&!NY_MEMBROS.find(m=>m.nome===prev))sel.value='';
}

function nyCopiarPlantel(){
  if(!DATA||!DATA.membros||!DATA.membros.length){toast('O ano atual não tem plantel para copiar','bad');return;}
  NY_MEMBROS=DATA.membros.map(m=>({nome:m.nome,fator:m.fator}));
  nyRender();
  // Sugerir o mesmo tesoureiro do ano atual, se vier na cópia
  const tesAtual=DATA.evento.tesoureiro;
  if(NY_MEMBROS.find(m=>m.nome===tesAtual))document.getElementById('adm-new-tes').value=tesAtual;
  toast('Plantel de '+DATA.evento.ano+' copiado ('+NY_MEMBROS.length+' membros) ✓','ok');
}

function nyAddMember(){
  const nome=(document.getElementById('ny-new-member').value||'').trim();
  const fator=parseFloat(document.getElementById('ny-new-fator').value)||1;
  if(!nome){toast('Indica o nome','bad');return;}
  if(NY_MEMBROS.find(m=>m.nome===nome)){toast(nome+' já está na lista','bad');return;}
  NY_MEMBROS.push({nome,fator});
  document.getElementById('ny-new-member').value='';
  document.getElementById('ny-new-fator').value='1';
  nyRender();
}

function nyRemoveMember(i){
  NY_MEMBROS.splice(i,1);
  nyRender();
}

function nyUpdateFator(i,v){
  const f=parseFloat(v);
  if(!isNaN(f)&&f>=0)NY_MEMBROS[i].fator=f;
}

async function addNewYear(){
  const yearVal=parseInt(document.getElementById('adm-new-year').value);
  const tesVal=document.getElementById('adm-new-tes').value;
  if(!yearVal||yearVal<2000||yearVal>2099){toast('Ano inválido','bad');return;}
  if(ALL_YEARS.some(y=>y.evento.ano===yearVal)){toast('Ano '+yearVal+' já existe','bad');return;}
  if(!NY_MEMBROS.length){toast('Adiciona pelo menos um membro ao plantel','bad');return;}
  if(!tesVal){toast('Escolhe o tesoureiro entre os membros','bad');return;}
  if(!NY_MEMBROS.find(m=>m.nome===tesVal)){toast('O tesoureiro tem de pertencer ao plantel','bad');return;}

  const membros=NY_MEMBROS.map(m=>({nome:m.nome,fator:m.fator,presencas:[],sexo:m.sexo||'M'}));

  // Sobras do ano anterior → entram automaticamente como mealheiro (sobras_ano_anterior).
  const mealheiros=[];
  const sobra=_sobrasAnoAnterior(yearVal,tesVal);
  if(sobra)mealheiros.push(sobra);

  const newYear={
    evento:{nome:'MEO '+yearVal,ano:yearVal,tesoureiro:tesVal,arredondaTotal:false,missaoPoupanca:0,fundoReserva:0,fatorModo:'fixo',fatorThreshold:FATOR_THRESHOLD_DEFAULT},
    membros,
    despesas:[],
    convidados:[],
    mealheiros,
    pagamentos:[],
    refeicoesDef:[]
  };

  ALL_YEARS.push(newYear);
  ALL_YEARS.sort((a,b)=>(a.evento.ano||0)-(b.evento.ano||0));
  YEAR_IDX=ALL_YEARS.findIndex(y=>y.evento.ano===yearVal);
  lsSet('fbv_ano',yearVal);
  DATA=JSON.parse(JSON.stringify(ALL_YEARS[YEAR_IDX]));
  CALC=calcular(JSON.parse(JSON.stringify(DATA)));
  updateYearUI();renderAll();

  const ok=await pushToGitHub('Criar ano '+yearVal);
  if(ok){
    const sobra=mealheiros.find(m=>m.subtipo==='sobras_ano_anterior');
    toast('Ano '+yearVal+' criado ✓'+(sobra?' · sobras '+eur(sobra.valor)+' transitadas':''),'ok');
    document.getElementById('adm-new-year').value='';
    document.getElementById('adm-new-tes').value='';
    NY_MEMBROS=[];
    nyRender();
    renderPlantel();
  }else{
    // Reverter o estado local se a gravação falhou (ex.: sessão expirada)
    ALL_YEARS=ALL_YEARS.filter(y=>y!==newYear);
    YEAR_IDX=Math.min(YEAR_IDX,ALL_YEARS.length-1);
    if(ALL_YEARS.length)selectYear();
  }
}

/* ── Plantel Management ── */
function renderPlantel(){
  if(!DATA)return;
  document.getElementById('adm-plantel-year').textContent=DATA.evento.ano||'';
  const nyYr=document.getElementById('ny-copy-year');
  if(nyYr)nyYr.textContent=DATA.evento.ano||'';
  nyRender();
  const list=document.getElementById('adm-plantel-list');
  if(!DATA.membros||!DATA.membros.length){
    list.innerHTML='<div class="empty sf">Sem membros neste ano</div>';
    return;
  }
  let h='';
  DATA.membros.forEach((m,i)=>{
    const isTes=m.nome===DATA.evento.tesoureiro;
    const varModo=DATA.evento&&DATA.evento.fatorModo==='variavel';
    const fatorCell=varModo
      ? `<span title="Calculado pelas presenças" style="font-weight:700">${fmtFator(fatorVariavel(m,DATA))}</span>`
      : `<input type="number" value="${m.fator}" step="0.05" min="0" onchange="updateFator(${i},this.value)" title="Fator">`;
    h+=`<div class="pl-item">
      <span class="pl-name">${m.nome}${isTes?' <span style="font-size:10px;color:var(--gold)">tesoureiro</span>':''}</span>
      <button class="pl-sexo ${m.sexo==='F'?'f':'m'}" onclick="toggleSexo(${i})" title="${m.sexo==='F'?'Mulher':'Homem'} — toca para alternar">${m.sexo==='F'?SEX_F_SVG:SEX_M_SVG}</button>
      <span class="pl-fator">${fatorCell}</span>
      <button class="pl-del" onclick="removeMember(${i})" title="Remover"${isTes?' disabled style="opacity:.2;cursor:default"':''}>✕</button>
    </div>`;
  });
  list.innerHTML=h;
}

async function addMember(){
  const nome=(document.getElementById('adm-new-member').value||'').trim();
  const fator=parseFloat(document.getElementById('adm-new-fator').value)||1;
  if(!nome){toast('Indica o nome','bad');return;}
  if(DATA.membros.find(m=>m.nome===nome)){toast(nome+' já existe no plantel','bad');return;}
  DATA.membros.push({nome,fator,presencas:[],sexo:'M'});
  const ok=await pushToGitHub('Adicionar '+nome+' ao plantel');
  if(ok){
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();renderPlantel();
    document.getElementById('adm-new-member').value='';
    document.getElementById('adm-new-fator').value='1';
    toast(nome+' adicionado ✓','ok');
  }
}

async function removeMember(idx){
  const nome=DATA.membros[idx].nome;
  if(nome===DATA.evento.tesoureiro){toast('Não podes remover o tesoureiro','bad');return;}
  // Check if member has ANY data in this year
  const hasDespesas=DATA.despesas.some(d=>d.quem===nome);
  const hasConvidados=DATA.convidados.some(c=>c.membro===nome);
  const hasPagamentos=(DATA.pagamentos||[]).some(p=>p.de===nome||p.para===nome);
  const hasMealheiros=(DATA.mealheiros||[]).some(m=>m.quem===nome);
  const hasPresencas=(DATA.membros[idx].presencas||[]).length>0;
  if(hasDespesas||hasConvidados||hasPagamentos||hasMealheiros||hasPresencas){
    toast(nome+' tem dados associados neste ano — não pode ser removido','bad');
    return;
  }
  if(!confirm('Remover '+nome+' do plantel?'))return;
  DATA.membros.splice(idx,1);
  const ok=await pushToGitHub('Remover '+nome+' do plantel');
  if(ok){
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();renderPlantel();
    toast(nome+' removido ✓','ok');
  }
}

async function updateFator(idx,val){
  const fator=parseFloat(val);
  if(isNaN(fator)||fator<0){toast('Fator inválido','bad');renderPlantel();return;}
  DATA.membros[idx].fator=fator;
  const ok=await pushToGitHub('Atualizar fator de '+DATA.membros[idx].nome);
  if(ok){
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();
    toast('Fator atualizado ✓','ok');
  }
}

async function toggleSexo(idx){
  const m=DATA.membros[idx];
  m.sexo=(m.sexo==='F')?'M':'F';
  renderPlantel();
  const ok=await pushToGitHub('Atualizar sexo de '+m.nome);
  if(ok){
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();renderPlantel();
    toast(m.nome+': '+(m.sexo==='F'?'Mulher':'Homem')+' ✓','ok');
  }else{
    m.sexo=(m.sexo==='F')?'M':'F';renderPlantel();
  }
}

/* ═══ CATEGORIAS DE ARTIGOS ═══
   Agrupadores de produto ("Sumos", "Talho", …) — migração db/categorias.sql.
   Duas peças: o dicionário (CATEGORIAS, gerido pelo admin em Definições) e a
   memória artigo→categoria (ART_CATS, chave = shopArtKey do nome). Quem
   preenche a memória: a AI na importação de fatura e no botão ✨ do Stock
   (origem 'ai', nunca pisa o que existe — ignore-duplicates), ou pessoas
   (origem 'manual'; mudar uma associação existente é só do admin).
   Aparecem como agrupadores no separador 🧺 Stock e na ordenação
   "Por categoria" das Compras. Sem migração corrida, tudo fica escondido. */
let CATS_TABLE=false;   // BD já tem categorias/artigo_categorias?
let CATEGORIAS=[];      // [{id,nome,descritivo}] ordenadas por nome
let ART_CATS={};        // artigo_key → {catId,origem}

function catById(id){return CATEGORIAS.find(c=>c.id===id)||null;}
function artCat(artigo){const m=ART_CATS[shopArtKey(artigo)];return m?catById(m.catId):null;}
// Lista nome+descritivo que segue no prompt do Gemini (fatura-ocr) — é por
// vir daqui que categorias novas ficam logo "conhecidas" pela AI
function catPromptList(){return CATEGORIAS.map(c=>({nome:c.nome,descritivo:c.descritivo||''}));}
function catOptionsHtml(cur){
  return '<option value="">— sem categoria —</option>'+
    CATEGORIAS.map(c=>`<option value="${c.id}"${c.id===cur?' selected':''}>${escHtml(c.nome)}</option>`).join('');
}
/* Ícone da categoria por palavras-chave do nome (sem acentos). Cobre as
   categorias típicas das Festas; uma categoria nova sem match fica 🏷️ —
   é só cosmético, nada depende disto. */
function catEmoji(nome){
  const s=shopArtKey(nome);
  const MAP=[[/(sumo|refriger)/,'🥤'],[/agua/,'💧'],[/(batata|snack|aperitivo)/,'🍟'],
    [/(churrasc|carvao|grelha|acendalha)/,'🔥'],[/(prato|copo|talher|guardanapo|descart|refeicao)/,'🍽️'],
    [/(talho|carne)/,'🥩'],[/(peix|marisc)/,'🐟'],[/(branca|espirituos|whisky|gin|vodka|licor)/,'🥃'],
    [/(cerveja|sidra)/,'🍺'],[/vinho/,'🍷'],[/(limpeza|detergente|higiene)/,'🧽'],
    [/(bricolagem|obra|ferramenta)/,'🛠️'],[/(sobremesa|fruta|doce|gelado)/,'🍉'],
    [/(entrada|queijo|pate|petisco)/,'🧀'],[/cafe/,'☕'],[/gelo/,'🧊'],[/(pao|padaria)/,'🥖'],[/outro/,'🧩']];
  for(const [re,e] of MAP)if(re.test(s))return e;
  return '🏷️';
}
/* Definir/alterar a categoria de um artigo a partir da UI. Regras:
   preencher um buraco pode qualquer membro; mudar/limpar o que já está
   definido é só do admin (o RLS garante o mesmo no servidor). */
async function catUserSetMapping(artigo,catId){
  if(!CATS_TABLE)return false;
  const key=shopArtKey(artigo);if(!key)return false;
  const cur=ART_CATS[key]||null;
  if((cur?cur.catId:null)===(catId||null))return false;
  if(cur&&!isAdmin())return false;
  try{
    if(!catId){
      await queueWrite(()=>sbReq('DELETE',`artigo_categorias?artigo_key=eq.${enc(key)}`));
      delete ART_CATS[key];
    }else{
      await queueWrite(()=>sbReq('POST','artigo_categorias?on_conflict=artigo_key',
        [{artigo_key:key,categoria_id:catId,origem:'manual',atualizado_em:new Date().toISOString()}],
        {Prefer:'resolution=merge-duplicates'}));
      ART_CATS[key]={catId,origem:'manual'};
    }
    if(TAB==='stock')renderStock();
    return true;
  }catch(e){toast('Categoria não guardada: '+(e.message||e),'bad');return false;}
}
/* Sugestões da AI (fatura ou botão ✨): só INSERE onde não há associação —
   ignore-duplicates garante que nunca pisa manual nem AI anterior. */
async function catAIMappings(pairs){
  if(!CATS_TABLE||!pairs||!pairs.length)return 0;
  const byNome={};CATEGORIAS.forEach(c=>{byNome[shopArtKey(c.nome)]=c.id;});
  const rows=[],seen=new Set();
  pairs.forEach(p=>{
    const key=shopArtKey(p.artigo);
    const cid=byNome[shopArtKey(p.categoria||'')];
    if(!key||!cid||ART_CATS[key]||seen.has(key))return;
    seen.add(key);
    rows.push({artigo_key:key,categoria_id:cid,origem:'ai'});
  });
  if(!rows.length)return 0;
  try{
    await queueWrite(()=>sbReq('POST','artigo_categorias?on_conflict=artigo_key',rows,{Prefer:'resolution=ignore-duplicates'}));
    rows.forEach(r=>{ART_CATS[r.artigo_key]={catId:r.categoria_id,origem:'ai'};});
    return rows.length;
  }catch(_){return 0;}
}

/* ── Gestão do dicionário (Definições › Categorias de Artigos, só admin) ── */
let _catEdit;   // undefined=fechado · null=nova · id=em edição
function renderAdmCats(){
  const el=document.getElementById('adm-cats-list');if(!el)return;
  if(!CATS_TABLE){
    el.innerHTML='<div class="note">Categorias indisponíveis — falta correr a migração <b>db/categorias.sql</b> no Supabase.</div>';
    document.getElementById('adm-cat-add').style.display='none';
    return;
  }
  const counts={};Object.keys(ART_CATS).forEach(k=>{const id=ART_CATS[k].catId;counts[id]=(counts[id]||0)+1;});
  el.innerHTML=CATEGORIAS.map(c=>`<div class="adm-cat-row" onclick="admCatEdit(${c.id})">
      <div class="adm-cat-main"><b>${escHtml(c.nome)}</b>${c.descritivo?`<div class="adm-cat-desc">${escHtml(c.descritivo)}</div>`:''}</div>
      <span class="cmp-count">${counts[c.id]||0}</span><span class="stk-chev">›</span>
    </div>`).join('')||'<div class="empty sf">Ainda sem categorias — cria a primeira.</div>';
}
function admCatEdit(id){
  _catEdit=id;
  const c=id!=null?CATEGORIAS.find(x=>x.id===id):null;
  document.getElementById('adm-cat-nome').value=c?c.nome:'';
  document.getElementById('adm-cat-desc').value=c?(c.descritivo||''):'';
  document.getElementById('adm-cat-del').style.display=c?'':'none';
  document.getElementById('adm-cat-form').style.display='';
  document.getElementById('adm-cat-add').style.display='none';
  if(!c)setTimeout(()=>document.getElementById('adm-cat-nome').focus(),50);
}
function admCatCancel(){
  _catEdit=undefined;
  document.getElementById('adm-cat-form').style.display='none';
  document.getElementById('adm-cat-add').style.display='';
}
async function admCatSave(){
  if(_catEdit===undefined)return;
  const nome=(document.getElementById('adm-cat-nome').value||'').trim();
  const desc=(document.getElementById('adm-cat-desc').value||'').trim();
  if(!nome){toast('Indica o nome da categoria','bad');return;}
  setSync('load','a guardar…');
  try{
    if(_catEdit!=null){
      await queueWrite(()=>sbReq('PATCH',`categorias?id=eq.${_catEdit}`,{nome,descritivo:desc}));
      const c=CATEGORIAS.find(x=>x.id===_catEdit);if(c){c.nome=nome;c.descritivo=desc;}
    }else{
      const ins=await queueWrite(()=>sbReq('POST','categorias',[{nome,descritivo:desc}],{Prefer:'return=representation'}));
      if(ins&&ins[0])CATEGORIAS.push({id:ins[0].id,nome,descritivo:desc});
    }
    CATEGORIAS.sort((a,b)=>a.nome.localeCompare(b.nome,'pt'));
    marcaGuardado();admCatCancel();renderAdmCats();
    toast('Categoria guardada ✓ — a AI já a conhece na próxima fatura','ok');
    if(TAB==='stock')renderStock();
    if(TAB==='compras')renderCompras();
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');}
}
async function admCatDelete(){
  if(_catEdit==null)return;
  const c=CATEGORIAS.find(x=>x.id===_catEdit);if(!c)return;
  const n=Object.keys(ART_CATS).filter(k=>ART_CATS[k].catId===c.id).length;
  if(!confirm(`Eliminar a categoria "${c.nome}"?${n?`\n\n${n} artigo(s) ficam sem categoria.`:''}`))return;
  setSync('load','a guardar…');
  try{
    await queueWrite(()=>sbReq('DELETE',`categorias?id=eq.${c.id}`));
    CATEGORIAS=CATEGORIAS.filter(x=>x.id!==c.id);
    Object.keys(ART_CATS).forEach(k=>{if(ART_CATS[k].catId===c.id)delete ART_CATS[k];});
    marcaGuardado();admCatCancel();renderAdmCats();
    toast('Categoria eliminada ✓','ok');
    if(TAB==='stock')renderStock();
    if(TAB==='compras')renderCompras();
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');}
}

/* ── ✨ Sugestões AI em lote (botão no Stock, só admin) ──
   Junta os artigos por categorizar (stock + lista de compras), pede ao
   fatura-ocr o modo só-texto, e mostra as sugestões num modal para rever
   antes de gravar — cada linha pode ser corrigida no próprio modal. */
let _catSug=null;   // [{artigo,key,catId}]
function catNamesPorCategorizar(){
  const seen={};
  const add=n=>{const k=shopArtKey(n);if(!k||seen[k]||ART_CATS[k])return;seen[k]=n;};
  stockArr().filter(stockBacked).forEach(l=>add(l.artigo));
  shopArr().filter(x=>!shopIsRemoved(x)).forEach(x=>add(x.artigo));
  return Object.values(seen);
}
async function catSugerir(){
  if(!CATS_TABLE||!isAdmin())return;
  if(!CATEGORIAS.length){toast('Cria primeiro categorias em Definições','bad');return;}
  const nomes=catNamesPorCategorizar();
  if(!nomes.length){toast('Está tudo categorizado 🎉','ok');return;}
  const btn=document.getElementById('stk-catsug-btn');
  if(btn){btn.disabled=true;btn.textContent='⏳ A pensar…';}
  try{
    const r=await sbFetch(`${SB_URL}/functions/v1/fatura-ocr`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify({artigos:nomes.slice(0,200),categorias:catPromptList()})
    });
    if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||('HTTP '+r.status));}
    const d=await r.json();
    const sug={};
    (d&&Array.isArray(d.sugestoes)?d.sugestoes:[]).forEach(s=>{if(s&&s.artigo)sug[shopArtKey(s.artigo)]=s.categoria||null;});
    const byNome={};CATEGORIAS.forEach(c=>{byNome[shopArtKey(c.nome)]=c.id;});
    _catSug=nomes.map(n=>{const k=shopArtKey(n);return{artigo:n,key:k,catId:byNome[shopArtKey(sug[k]||'')]||null};})
      .sort((a,b)=>(a.catId?0:1)-(b.catId?0:1)||a.artigo.localeCompare(b.artigo,'pt'));
    catSugRender();
    document.getElementById('catsug-bg').classList.add('show');
    document.body.classList.add('no-scroll');
  }catch(e){toast('Sugestões falharam: '+(e.message||e),'bad');}
  finally{if(btn){btn.disabled=false;btn.textContent='✨ Categorias';}}
}
function catSugRender(){
  const com=_catSug.filter(s=>s.catId).length;
  document.getElementById('catsug-info').textContent=
    `${_catSug.length} artigo(s) por categorizar — a AI sugeriu ${com}. Revê, corrige o que for preciso e grava.`;
  document.getElementById('catsug-list').innerHTML=_catSug.map((s,i)=>`<div class="catsug-row">
      <span class="catsug-art">${escHtml(s.artigo)}</span>
      <select onchange="_catSug[${i}].catId=parseInt(this.value)||null">${catOptionsHtml(s.catId)}</select>
    </div>`).join('');
}
function catSugClose(){
  document.getElementById('catsug-bg').classList.remove('show');
  document.body.classList.remove('no-scroll');
  _catSug=null;
}
async function catSugApply(){
  if(!_catSug)return;
  const rows=_catSug.filter(s=>s.catId).map(s=>({artigo_key:s.key,categoria_id:s.catId,origem:'ai'}));
  if(!rows.length){catSugClose();return;}
  const btn=document.getElementById('catsug-save');btn.disabled=true;
  setSync('load','a guardar…');
  try{
    await queueWrite(()=>sbReq('POST','artigo_categorias?on_conflict=artigo_key',rows,{Prefer:'resolution=ignore-duplicates'}));
    rows.forEach(r=>{ART_CATS[r.artigo_key]={catId:r.categoria_id,origem:'ai'};});
    marcaGuardado();
    toast(`${rows.length} artigo(s) categorizados ✓`,'ok');
    catSugClose();
    if(TAB==='stock')renderStock();
    if(TAB==='compras')renderCompras();
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');}
  btn.disabled=false;
}

/* ═══ COMPRAS / SHOPLIST ═══
   Lista partilhada de artigos em falta. Fluxo:
   1) alguém adiciona artigos (artigo, qtd, tipo, e se Almoço/Jantar a refeição alvo)
   2) alguém marca "Eu trato" (passa para "O meu carrinho")
   3) durante as compras marca "no carrinho" físico
   4) ao registar a compra, define-se uma LINHA por grupo (tipo+refeição) mais os
      "outros gastos" avulsos. Cada linha vira UMA despesa marcada com o mesmo
      compra_id → a distribuição pelas refeições respeita as datas da lista (o motor
      calcular() aloca Almoço/Jantar com data_valor diretamente à refeição) e a compra
      pode ser reaberta e editada como um todo a partir do cash-flow.
   Regras de posse:
   - Só o autor (criado_por) ou o admin removem um artigo — e remover é soft-delete
     (estado='removido'): vai para o histórico "Removidos" e, se alguém o reclamou,
     mantém-se visível para essa pessoa com alerta até ela o largar/comprar.
   - Ninguém "rouba" um artigo reclamado: só o próprio larga (o claim tem guarda
     anti-corrida no servidor); o admin pode reatribuir no detalhe do artigo.
   - O estado "no carrinho" é privado de quem trata; os outros só veem quem trata. */

const SHOP_TIPOS=['Gerais','Bebidas','Almoço','Jantar','Renda','Cerveja'];
function shopArr(){if(DATA&&!DATA.shoplist)DATA.shoplist=[];return (DATA&&DATA.shoplist)||[];}
// Um artigo só está mesmo "comprado" se ainda existir alguma despesa com o seu
// compra_id. Se as despesas foram apagadas por outra via (ex.: Reset cash-flows),
// o artigo é tratado como pendente — nunca fica órfão/invisível na lista.
function shopBacked(it){return !!it.compraId&&(DATA.despesas||[]).some(d=>d.compraId===it.compraId);}
// 'removido' = soft-delete: sai da lista ativa mas fica no histórico (e visível,
// com alerta, para quem estiver a tratar dele). cf_desc guarda quem removeu —
// a coluna só é usada pelas compras quando estado='comprado', por isso está livre aqui.
function shopIsRemoved(it){return it.estado==='removido';}
function shopIsBought(it){return it.estado==='comprado'&&shopBacked(it);}
function shopIsPending(it){return !shopIsBought(it)&&!shopIsRemoved(it);}
// "Ativo para mim": estou a tratar dele e ainda não foi comprado (mesmo que
// entretanto o autor o tenha removido — mantém-se na minha checklist com alerta)
function shopMineActive(it){return shopMine(it)&&!shopIsBought(it);}
function shopTipoIcon(t){return{Gerais:'🧾',Bebidas:'🥤',Almoço:'☀️',Jantar:'🌙',Renda:'🏠',Cerveja:'🍺'}[t]||'🛒';}
function shopIsMeal(t){return t==='Almoço'||t==='Jantar';}
function shopGroupKey(it){return it.tipo+'|'+(it.dataValor||'');}
function shopGroupLabel(tipo,dataValor){
  if(shopIsMeal(tipo)&&dataValor){
    const rd=(DATA.refeicoesDef||[]).find(r=>r.ref===tipo&&r.data===dataValor);
    return `${shopTipoIcon(tipo)} ${tipo} ${fmtDiaMes(dataValor)}`+(rd&&rd.prato?` · ${rd.prato}`:'');
  }
  return `${shopTipoIcon(tipo)} ${tipo}`;
}
function shopMealOptions(ref,selData){
  const meals=(DATA.refeicoesDef||[]).filter(r=>r.ref===ref).slice().sort((a,b)=>(a.data||'').localeCompare(b.data||''));
  if(!meals.length)return `<option value="">(sem ${ref.toLowerCase()}s)</option>`;
  return `<option value="">— refeição —</option>`+meals.map(r=>`<option value="${r.data}"${selData===r.data?' selected':''}>${fmtDiaMes(r.data)}${r.prato?' · '+r.prato:''}</option>`).join('');
}
// Criação: checkboxes em vez de select — o mesmo artigo pode nascer para
// várias refeições de uma vez (cria um registo por refeição).
function shopMealChecks(ref){
  const meals=(DATA.refeicoesDef||[]).filter(r=>r.ref===ref).slice().sort((a,b)=>(a.data||'').localeCompare(b.data||''));
  if(!meals.length)return `<div class="note">Sem ${ref.toLowerCase()}s definidos — adiciona a refeição primeiro no separador Refeições.</div>`;
  return meals.map(r=>`<label class="cmp-pick-row"><input type="checkbox" value="${r.data}"><span>${fmtDiaMes(r.data)}${r.prato?' · '+escHtml(r.prato):''}</span></label>`).join('');
}
function shopCanWrite(){return !!_sbSession&&(isAdmin()||MY_NAMES.length>0);}
// Normaliza quantidades em texto livre (1KG / 3 kilos / 500 gr → 1 kg / 3 kg / 500 g).
// Converte g≥1000→kg e ml≥1000→L. Se não reconhecer, mantém o texto tal como veio.
const _QTY_UNITS={
  kg:['kg','kgs','kilo','kilos','quilo','quilos','kilograma','kilogramas','quilograma','quilogramas','kilog','kgr'],
  g:['g','gr','grs','grama','gramas','grm'],
  l:['l','lt','lts','litro','litros'],
  ml:['ml','mls','mililitro','mililitros'],
  un:['un','uni','unid','unidade','unidades','u','x','peca','pecas'],
  duzia:['duzia','duzias'],
  pacote:['pacote','pacotes','pct','pack','packs','embalagem','embalagens'],
  lata:['lata','latas'],
  garrafa:['garrafa','garrafas'],
  caixa:['caixa','caixas','cx'],
  saco:['saco','sacos'],
  grade:['grade','grades'],
  fatia:['fatia','fatias'],
  molho:['molho','molhos']
};
function normalizeQty(raw){
  let s=(raw||'').trim().replace(/\s+/g,' ');
  if(!s)return '';
  const m=s.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);   // número + resto
  if(!m)return s;                                   // sem número → deixa como está
  let num=parseFloat(m[1].replace(',','.'));
  let rest=(m[2]||'').trim();
  const norm=rest.toLowerCase().replace(/\.$/,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  let unit=null;
  for(const k in _QTY_UNITS){if(_QTY_UNITS[k].includes(norm)){unit=k;break;}}
  if(unit==='g'&&num>=1000){num=num/1000;unit='kg';}
  else if(unit==='ml'&&num>=1000){num=num/1000;unit='l';}
  const fmt=n=>String(Math.round(n*1000)/1000).replace('.',',');
  const label=(u,n)=>{
    if(u==='kg')return 'kg';if(u==='g')return 'g';if(u==='l')return 'L';if(u==='ml')return 'ml';if(u==='un')return 'un';
    const pl={duzia:['dúzia','dúzias'],pacote:['pacote','pacotes'],lata:['lata','latas'],garrafa:['garrafa','garrafas'],caixa:['caixa','caixas'],saco:['saco','sacos'],grade:['grade','grades'],fatia:['fatia','fatias'],molho:['molho','molhos']};
    return pl[u]?(n===1?pl[u][0]:pl[u][1]):u;
  };
  if(unit)return `${fmt(num)} ${label(unit,num)}`;
  if(rest)return `${fmt(num)} ${rest}`;   // unidade desconhecida → nº normalizado + texto original
  return fmt(num);                        // só número
}
// Etiqueta qtd + tamanho/embalagem para mostrar (ex.: "4 × lata 250 ml").
// Na BD são colunas separadas (quantidade, tamanho) — juntam-se só na UI.
function shopQtyLabel(it){const q=normalizeQty(it.quantidade),t=(it.tamanho||'').trim();return q&&t?`${q} × ${t}`:(q||t);}
// Nomes com que reclamo artigos (próprio + cônjuge; admin sem membro → 'Admin')
function myClaimNames(){const s=new Set(MY_NAMES);const p=myPrimaryName()||(isAdmin()?'Admin':'');if(p)s.add(p);return s;}
function shopMine(it){return !!it.tratadoPor&&myClaimNames().has(it.tratadoPor);}
// "Meu carrinho" é PESSOAL: só conta o que reclamei em meu próprio nome (não o
// do cônjuge). O agregado continua a co-gerir (largar/marcar), mas a checklist
// da aba Carrinho mostra só os meus — o que o cônjuge leva vê-se em "Já em
// carrinhos", com o nome dele.
function myOwnClaimName(){return myPrimaryName()||(isAdmin()?'Admin':'');}
function shopMineOwn(it){const n=myOwnClaimName();return !!n&&it.tratadoPor===n;}
function shopCanEditItem(it){return isAdmin()||(it.criadoPor&&myClaimNames().has(it.criadoPor));}

/* ── STOCK POR REFEIÇÃO ──────────────────────────────────────────────
   Artigos comprados para VÁRIAS refeições (ex.: 10 pacotes de batatas p/ dois
   jantares) são registados como LOTES (tabela stock_lotes): quantidade + preço
   por artigo. O valor do lote entra na compra numa linha "🧺 Stock" (Gerais →
   bolsa comum) e as ALOCAÇÕES (lote → refeição → qtd) movem-no, no cálculo,
   para custos diretos das refeições — sem nunca reescrever as despesas reais.
   Alocação automática: FIFO por ordem de data das refeições, cobrindo a
   procura da lista de compras; sobra fica na bolsa comum; o admin ajusta tudo
   no detalhe do lote. Reservado vs consumido é derivado da data da refeição. */
const STOCK_OBS='🧺 Stock';
function stockArr(){if(DATA&&!DATA.stockLotes)DATA.stockLotes=[];return (DATA&&DATA.stockLotes)||[];}
// Lote órfão (compra apagada/limpa): sai das contas e das vistas
function stockBacked(l){return (DATA.despesas||[]).some(d=>d.compraId===l.compraId);}
function hojeISO(){return new Date().toISOString().slice(0,10);}

// Interpreta quantidade em texto ("5 pacotes", "2,5 kg") → {n,u} com unidade
// canónica (g→kg, ml→L; desconhecida fica o texto). null se não houver número.
function qtyParse(raw){
  const s=(raw||'').trim();
  const m=s.match(/^(\d+(?:[.,]\d+)?)\s*(.*)$/);
  if(!m)return null;
  let n=parseFloat(m[1].replace(',','.'));
  const norm=(m[2]||'').trim().toLowerCase().replace(/\.$/,'').normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  let u='';
  for(const k in _QTY_UNITS){if(_QTY_UNITS[k].includes(norm)){u=k;break;}}
  if(!u&&norm)u=norm;
  if(u==='g'){n=n/1000;u='kg';}
  if(u==='ml'){n=n/1000;u='l';}
  return{n,u};
}
function fmtQty(n,u){
  const s=String(Math.round(n*1000)/1000).replace('.',',');
  const pl={duzia:['dúzia','dúzias'],pacote:['pacote','pacotes'],lata:['lata','latas'],garrafa:['garrafa','garrafas'],caixa:['caixa','caixas'],saco:['saco','sacos'],grade:['grade','grades'],fatia:['fatia','fatias'],molho:['molho','molhos']};
  const lbl=u==='kg'?'kg':u==='l'?'L':u==='un'?'un':pl[u]?(n===1?pl[u][0]:pl[u][1]):u;
  return lbl?`${s} ${lbl}`:s;
}

/* Procura de um artigo por refeição (o que foi pedido na lista, comprado ou
   não — a procura é o pedido). Só entra o que tiver qtd numérica na mesma
   unidade do lote. Chave: 'tipo|data'. */
function stockDemandFor(artigo,u){
  const dem={};
  shopArr().forEach(it=>{
    if(!shopIsMeal(it.tipo)||!it.dataValor||shopIsRemoved(it))return;
    if(!shopSameArtigo(it.artigo,artigo))return;
    const q=qtyParse(it.quantidade);
    if(!q||q.u!==u)return;
    const k=it.tipo+'|'+it.dataValor;
    dem[k]=rnd((dem[k]||0)+q.n,3);
  });
  return dem;
}
/* Já alocado a cada refeição pelos OUTROS lotes do mesmo artigo.
   Lotes órfãos (a compra foi apagada) NÃO contam — senão as alocações de uma
   compra apagada continuavam a assombrar as propostas da compra seguinte. */
function stockAllocatedFor(artigo,u,skipLotId){
  const alloc={};
  const skip=skipLotId==null?null:new Set(Array.isArray(skipLotId)?skipLotId:[skipLotId]);
  stockArr().forEach(l=>{
    if(skip&&skip.has(l._id))return;
    if(!stockBacked(l))return;
    if(!shopSameArtigo(l.artigo,artigo)||(l.unidade||'')!==u)return;
    (l.alocacoes||[]).forEach(a=>{const k=a.tipo+'|'+a.data;alloc[k]=rnd((alloc[k]||0)+(+a.qtd||0),3);});
  });
  return alloc;
}
/* Qtd livre (sem alocação) em stock para um artigo — para a dica "há em stock". */
function stockFreeFor(artigo,u){
  let free=0;
  stockArr().forEach(l=>{
    if(!stockBacked(l)||!shopSameArtigo(l.artigo,artigo)||(l.unidade||'')!==u)return;
    const aloc=(l.alocacoes||[]).reduce((a,x)=>a+(+x.qtd||0),0);
    free=rnd(free+Math.max(0,l.qtd-aloc),3);
  });
  return free;
}
/* Qtd já alocada do stock a UMA refeição para um artigo — para a dica "já em
   stock" na lista de compras dessa refeição (quanto do pedido já está coberto). */
function mealStockAllocFor(artigo,u,ref,data){
  let q=0;
  stockArr().forEach(l=>{
    if(!stockBacked(l)||!shopSameArtigo(l.artigo,artigo)||(l.unidade||'')!==u)return;
    (l.alocacoes||[]).forEach(a=>{if(a.tipo===ref&&a.data===data)q=rnd(q+(+a.qtd||0),3);});
  });
  return q;
}
// Há ALGUMA alocação deste artigo à refeição? (qualquer unidade — para a
// cobertura binária de pedidos sem quantidade numérica)
function mealStockAllocAnyFor(artigo,ref,data){
  return stockArr().some(l=>stockBacked(l)&&shopSameArtigo(l.artigo,artigo)
    &&(l.alocacoes||[]).some(a=>a.tipo===ref&&a.data===data&&+a.qtd>0));
}
/* ── Cobertura da necessidade (modelo "a lista nunca morre") ──
   A quantidade pedida na lista é a NECESSIDADE durável da refeição; a cobertura
   é DERIVADA a cada momento do stock alocado a essa refeição — nunca gravada.
   Por isso é auto-reversível: tira-se a alocação (ou apaga-se a compra) e a
   necessidade volta sozinha ao "Em falta"; aloca-se e o pedido fica tratado.
   A conta faz-se ao nível do PAR artigo+refeição (todos os pedidos pendentes
   do mesmo artigo para a mesma refeição partilham a mesma cobertura). */
function shopItemCoverage(it){
  if(!STOCK_TABLE||!shopIsMeal(it.tipo)||!it.dataValor)return null;
  const q=qtyParse(it.quantidade);
  if(!q)return null;
  // A necessidade soma os pedidos pendentes E os comprados cujo artigo tem
  // lote em stock — a compra desses materializou-se em alocação, que também
  // está no `aloc`; sem os contar, o alocado deles "cobriria" pedidos novos.
  // Comprado SEM lote foi satisfeito fora do stock (ex.: "Só totais") e fica
  // de fora dos dois lados da conta.
  const temLote=stockArr().some(l=>stockBacked(l)&&shopSameArtigo(l.artigo,it.artigo));
  let need=0;
  shopArr().forEach(x=>{
    if(shopIsRemoved(x)||x.tipo!==it.tipo||x.dataValor!==it.dataValor)return;
    if(!shopSameArtigo(x.artigo,it.artigo))return;
    if(shopIsBought(x)&&!temLote)return;
    const xq=qtyParse(x.quantidade);
    if(xq&&xq.u===q.u)need=rnd(need+xq.n,3);
  });
  const aloc=mealStockAllocFor(it.artigo,q.u,it.tipo,it.dataValor);
  return {need,aloc,falta:Math.max(0,rnd(need-aloc,3)),u:q.u};
}
/* Pedido pendente totalmente coberto pelo stock alocado à sua refeição —
   sai do "falta quem trate" (não há nada a comprar) mas continua visível;
   se a alocação mudar, volta sozinho. Sem qtd numérica: cobertura binária. */
function shopIsCovered(it){
  if(!STOCK_TABLE||!shopIsPending(it)||!shopIsMeal(it.tipo)||!it.dataValor)return false;
  const c=shopItemCoverage(it);
  if(c)return c.aloc>0.0005&&c.falta<=0.0005;
  return mealStockAllocAnyFor(it.artigo,it.tipo,it.dataValor);
}
/* Dica de stock para um artigo da lista — partilhada pela lista da refeição e
   pelo Shop List (onde quem vai às compras a lê). Devolve {ok,txt} ou null:
   - pedido com stock alocado à refeição → quanto está coberto e quanto falta
     comprar (ok=true, verde);
   - senão, se houver stock livre por alocar deste artigo → sugere alocá-lo. */
function shopStockHint(it){
  if(!STOCK_TABLE||shopIsBought(it)||shopIsRemoved(it))return null;
  const c=shopItemCoverage(it);
  if(c){
    if(c.aloc>0.0005){
      const cob=rnd(Math.min(c.aloc,c.need),3);
      return {ok:true,txt:c.falta>0.0005
        ?`🧺 ${fmtQty(cob,c.u)} já em stock — falta comprar ${fmtQty(c.falta,c.u)}`
        :`🧺 pedido coberto pelo stock (${fmtQty(cob,c.u)})`};
    }
    const free=stockFreeFor(it.artigo,c.u);
    if(free>0)return {ok:false,txt:`🧺 há ${fmtQty(free,c.u)} em stock por alocar`};
    return null;
  }
  // Sem quantidade numérica: cobertura binária (há/não há alocação à refeição)
  if(shopIsMeal(it.tipo)&&it.dataValor&&mealStockAllocAnyFor(it.artigo,it.tipo,it.dataValor))
    return {ok:true,txt:'🧺 coberto pelo stock'};
  return null;
}
/* Reparte a qtd do lote pelas refeições que ainda pedem o artigo, cobrindo a
   procura ainda em aberto (procura da lista menos o que já está alocado).
   - Com refeições PEDIDAS (preferKeys — as do carrinho desta compra), aloca-se
     SÓ a essas: o que sobrar fica na bolsa comum, não se espalha por refeições
     que esta compra não pediu.
   - Sem refeições pedidas, cobre-se toda a procura por ordem de data (FIFO).
   A sobra fica sempre sem alocação (bolsa comum). Se o artigo foi pedido para
   UMA refeição mas sem quantidade numérica na lista, vai tudo para essa. */
function fifoAlocar(artigo,qtd,u,skipLotId,preferKeys){
  const dem=stockDemandFor(artigo,u);
  const done=stockAllocatedFor(artigo,u,skipLotId);
  const byDate=ks=>ks.slice().sort((a,b)=>(a.split('|')[1]).localeCompare(b.split('|')[1])||a.localeCompare(b));
  const hasPref=!!(preferKeys&&preferKeys.length);
  const keys=hasPref?byDate(preferKeys.filter(k=>dem[k]!=null)):byDate(Object.keys(dem));
  let rest=qtd;const out=[];
  for(const k of keys){
    if(rest<=0)break;
    const falta=Math.max(0,rnd(dem[k]-(done[k]||0),3));
    const take=Math.min(rest,falta);
    if(take>0){const[tipo,data]=k.split('|');out.push({tipo,data,qtd:rnd(take,3)});rest=rnd(rest-take,3);}
  }
  // Pedido para UMA refeição SEM procura numérica na lista → vai tudo para lá
  // (não há falta a calcular; honra-se o pedido). Se a procura existe mas já
  // está coberta, a sobra fica antes na bolsa comum (não se empilha).
  if(!out.length&&preferKeys&&preferKeys.length===1&&dem[preferKeys[0]]==null){
    const[tipo,data]=preferKeys[0].split('|');
    out.push({tipo,data,qtd:rnd(qtd,3)});
  }
  return out;
}

/* Um destino (string) → entrada de alocação: '' = por alocar (FIFO, fora daqui);
   'Tipo' = tipo puro (data null); 'Ref|data' = refeição. */
function destinoAloc(destino,qtd){
  if(!destino)return null;
  if(String(destino).includes('|')){const p=String(destino).split('|');return{tipo:p[0],data:p[1],qtd:rnd(qtd,3)};}
  return{tipo:destino,data:null,qtd:rnd(qtd,3)};
}
/* Resolve as alocações de um lote a gravar a partir do destino/split escolhido.
   Sem destino (''), reparte por FIFO pela procura das refeições (sobra fica na
   bolsa comum). Corre no momento da gravação, vendo os lotes já empilhados. */
function resolveLoteAlocs(l){
  if(l.splits&&l.splits.length){
    const out=[];
    l.splits.forEach(s=>{const q=parseFloat(String(s.qtd).replace(',','.'))||0;if(q<=0)return;const a=destinoAloc(s.destino,q);if(a)out.push(a);});
    if(out.length)return out;
  }
  if(l.destino){const a=destinoAloc(l.destino,l.qtd);if(a)return[a];}
  return fifoAlocar(l.artigo,l.qtd,l.unidade,null,(l.keys&&l.keys.length)?l.keys:null);
}

/* Uma alocação aponta a uma REFEIÇÃO (tipo Almoço/Jantar + data) ou a um TIPO
   puro (Gerais/Bebidas/Cerveja/Renda, sem data — cai no pool desse tipo). */
function alocIsMeal(a){return shopIsMeal(a&&a.tipo)&&!!(a&&a.data);}
// Alocação gravada → chave de destino usada na UI ('' | 'Tipo' | 'Ref|data')
function alocToDestino(a){return alocIsMeal(a)?a.tipo+'|'+a.data:(a&&a.tipo)||'';}
// Ordenação de destinos para mostrar: refeições primeiro, por ordem do
// calendário; depois os tipos puros por ordem alfabética
function destKeyCmp(a,b){
  const A=destinoAloc(a,0),B=destinoAloc(b,0);
  const am=alocIsMeal(A),bm=alocIsMeal(B);
  if(am&&bm)return (A.data||'').localeCompare(B.data||'')||A.tipo.localeCompare(B.tipo,'pt');
  if(am!==bm)return am?-1:1;
  return (A&&A.tipo||'').localeCompare(B&&B.tipo||'','pt');
}

/* Aplica o stock no motor de cálculo: por compra, abate na linha "🧺 Stock"
   (Gerais) o valor alocado dos lotes e cria despesas diretas sintéticas —
   às refeições (tipo Almoço/Jantar + data_valor) ou a um tipo puro
   (Bebidas/Cerveja/…) reclassificando o valor para esse pool. Corre SÓ na
   cópia que o calcular() recebe — as despesas guardadas (quem pagou o quê)
   ficam intactas. Alocações a refeições apagadas ficam na bolsa comum. */
function aplicarStock(data){
  const lotes=data.stockLotes||[];if(!lotes.length)return;
  const refOk={};(data.refeicoesDef||[]).forEach(r=>{refOk[r.ref+'|'+r.data]=true;});
  const byCompra={};lotes.forEach(l=>{(byCompra[l.compraId]=byCompra[l.compraId]||[]).push(l);});
  for(const cid in byCompra){
    const linha=(data.despesas||[]).find(d=>d.compraId===cid&&d.tipo==='Gerais'&&(d.obs||'')===STOCK_OBS);
    if(!linha)continue;   // compra apagada → lotes órfãos não contam
    let resto=linha.valor;
    byCompra[cid].forEach(l=>{
      if(!(+l.qtd>0))return;
      const unit=l.valor/l.qtd;
      (l.alocacoes||[]).forEach(a=>{
        const meal=alocIsMeal(a);
        // refeição apagada → volta à bolsa comum; tipo puro entra sempre.
        // dataValor só importa para refeições (o calcular ignora-a nos tipos).
        if(meal&&!refOk[a.tipo+'|'+a.data])return;
        const v=Math.min(rnd(unit*(+a.qtd||0),2),resto);
        if(v<=0)return;
        data.despesas.push({quem:linha.quem,dataDesp:linha.dataDesp,dataValor:meal?a.data:linha.dataDesp,desc:l.artigo,tipo:a.tipo,valor:v,obs:STOCK_OBS,compraId:null,_stock:true});
        resto=rnd(resto-v,2);
      });
    });
    linha.valor=Math.max(0,resto);
  }
}

function shopItemCard(it,mineView,noBadge){
  const meal=shopIsMeal(it.tipo)&&it.dataValor;
  const badge=noBadge?'':(meal?`<span class="cmp-badge meal">${shopTipoIcon(it.tipo)} ${fmtDiaMes(it.dataValor)}</span>`:`<span class="cmp-badge">${shopTipoIcon(it.tipo)} ${it.tipo}</span>`);
  const qtdTxt=shopQtyLabel(it);
  const qtd=qtdTxt?`<span class="cmp-qtd">${escHtml(qtdTxt)}</span>`:'';
  const removed=shopIsRemoved(it);
  // Cartão de UMA linha (escala para dezenas de artigos). Editar/eliminar/largar
  // vivem no detalhe (toca no artigo); no cartão só a ação principal de cada vista.
  let check='',right='',sub='';
  if(mineView){
    // Checklist de compras: a bolinha marca "já está no carrinho físico".
    // Este estado é só para orientação de quem trata — os outros não o veem.
    check=`<button class="cmp-check write-action ${it.noCarrinho?'on':''}" onclick="event.stopPropagation();toggleCart(${it._id})" aria-label="Já no carrinho">✓</button>`;
    // ✕ = largar o artigo (volta a "Em falta") sem ter de abrir o detalhe
    right=`<button class="cmp-x write-action" aria-label="Tirar do carrinho" onclick="event.stopPropagation();unclaimItem(${it._id})">✕</button>`;
  }else if(it.tratadoPor){
    // Para quem não trata, basta saber QUE está entregue e a QUEM (o estado
    // do carrinho é detalhe de quem anda nas compras).
    right=`<span class="cmp-chip">🛒 ${escHtml(it.tratadoPor)}</span>`;
  }else{
    if(it.criadoPor)sub=`<div class="cmp-sub">pedido por ${escHtml(it.criadoPor)}</div>`;
    // Pedido coberto pelo stock: não há nada a comprar — sem botão de carrinho
    // (a dica verde diz o estado; se a alocação mudar, o botão volta sozinho)
    right=shopIsCovered(it)?''
      :`<button class="cmp-mini cart write-action" onclick="event.stopPropagation();claimItem(${it._id})"><i class="cmp-plus">＋</i>🛒 Carrinho</button>`;
  }
  if(removed)sub=`<div class="cmp-sub alert">⚠️ removido por ${escHtml(it.cfDesc||'?')}${mineView?' — abre para largar':''}</div>`;
  // Mesma dica de stock da lista da refeição — aqui é onde quem faz as compras
  // repara que parte (ou tudo) do pedido já está coberto pelo stock.
  const sh=shopStockHint(it);
  const hint=sh?`<div class="cmp-hint${sh.ok?' ok':''}">${escHtml(sh.txt)}</div>`:'';
  return `<div class="cmp-item cmp-line cmp-tap${mineView&&it.noCarrinho?' incart':''}${removed?' removed':''}" onclick="openShopItemModal(${it._id})">
    ${check}
    <div class="cmp-main"><div class="cmp-artigo">${escHtml(it.artigo)}${qtd}</div>${hint}${sub}</div>
    ${badge}${right}<span class="cmp-chev-r">›</span>
  </div>`;
}

/* Lista agrupada por refeição/tipo: um cabeçalho por grupo (ex.: 🍳 Almoço 8/ago
   · Cabrito) com contagem — é o sumário da lista por refeição no separador
   Compras. O badge de cada cartão sai: o cabeçalho do grupo já identifica. */
function shopGroupedList(list,mineView){
  const counts={};list.forEach(it=>{const k=shopGroupKey(it);counts[k]=(counts[k]||0)+1;});
  let h='',last=null;
  list.forEach(it=>{
    const k=shopGroupKey(it);
    if(k!==last){h+=`<div class="cmp-grp-hdr sf"><span class="cmp-grp-label">${shopGroupLabel(it.tipo,it.dataValor)}</span><span class="cmp-count">${counts[k]}</span></div>`;last=k;}
    h+=shopItemCard(it,mineView,true);
  });
  return '<div class="cmp-list">'+h+'</div>';
}

/* Lista agrupada por CATEGORIA de produto (Sumos, Talho, …): a vista para
   fazer as compras "por corredor". O badge de refeição/tipo mantém-se em cada
   cartão — o cabeçalho diz o produto, não o destino. Sem categoria no fim. */
function shopCatGroupedList(list,mineView){
  const keyOf=it=>{const c=artCat(it.artigo);return c?'c'+c.id:'none';};
  // Sem categoria ("Outros") sempre no fim, independentemente do sort de quem chama
  list=list.filter(it=>keyOf(it)!=='none').concat(list.filter(it=>keyOf(it)==='none'));
  const counts={};list.forEach(it=>{const k=keyOf(it);counts[k]=(counts[k]||0)+1;});
  let h='',last=null;
  list.forEach(it=>{
    const k=keyOf(it);
    if(k!==last){
      const c=artCat(it.artigo);
      const nome=c?c.nome:'Outros';
      h+=`<div class="cmp-grp-hdr sf"><span class="cmp-grp-label">${catEmoji(nome)} ${escHtml(nome)}</span><span class="cmp-count">${counts[k]}</span></div>`;
      last=k;
    }
    h+=shopItemCard(it,mineView,false);
  });
  return '<div class="cmp-list">'+h+'</div>';
}

/* Lista de compras da refeição — mostra no cartão da refeição (tab Refeições)
   os artigos da shoplist ligados a ela (tipo Almoço/Jantar + data). É a MESMA
   lista do separador Compras: adicionar aqui ou lá dá exatamente no mesmo. */
const MEAL_SHOP_OPEN={};   // aberto/fechado por refeição (sobrevive a re-renders)
function mealShopSection(rd){
  if(!shopIsMeal(rd.ref))return '';
  const items=shopArr().filter(it=>it.tipo===rd.ref&&it.dataValor===rd.data&&!shopIsRemoved(it))
    .sort((a,b)=>a.artigo.localeCompare(b.artigo,'pt'));
  // Lotes de stock alocados a ESTA refeição (reservado se ainda não passou a data)
  const alocs=[];
  stockArr().forEach(l=>{
    if(!stockBacked(l))return;
    (l.alocacoes||[]).forEach(a=>{
      if(a.tipo!==rd.ref||a.data!==rd.data||!(+a.qtd>0))return;
      const unit=l.qtd>0?l.valor/l.qtd:0;
      alocs.push({l,qtd:+a.qtd,val:rnd(unit*a.qtd,2)});
    });
  });
  alocs.sort((a,b)=>a.l.artigo.localeCompare(b.l.artigo,'pt'));
  const past=rd.data<hojeISO();
  const canAdd=shopCanWrite()&&!contasFechadas()&&!past;
  if(!items.length&&!alocs.length&&!canAdd)return '';
  const key=rd.data+'|'+rd.ref;
  const alocLines=alocs.map(x=>`<div class="msl-it stk" onclick="openLoteModal(${x.l._id})">
      <span class="msl-art">${escHtml(x.l.artigo)} <i>${escHtml(fmtQty(x.qtd,x.l.unidade))}</i></span><span class="msl-st ok">${eur(x.val)}</span></div>`).join('');
  const lineOf=(it,dim)=>{
    const done=shopIsBought(it);
    const qtdTxt=shopQtyLabel(it);
    // Sem "riscado": um artigo comprado é uma linha normal do bloco Comprado,
    // igual às dos lotes — o bloco onde está já diz tudo
    const st=done?''
      :it.tratadoPor?`<span class="msl-st">🛒 ${escHtml(it.tratadoPor)}</span>`
      :'<span class="msl-st falta">falta quem trate</span>';
    // Dica de stock: quanto do pedido já está coberto por stock alocado a esta
    // refeição (e quanto falta), ou stock livre por alocar. Ver shopStockHint.
    let hint='';
    if(!done&&!past){const sh=shopStockHint(it);if(sh)hint=`<div class="msl-hint${sh.ok?' ok':''}">${escHtml(sh.txt)}</div>`;}
    return `<div class="msl-it${dim?' msl-dim':''}" onclick="openShopItemModal(${it._id})">
      <span class="msl-art">${escHtml(it.artigo)}${qtdTxt?` <i>${escHtml(qtdTxt)}</i>`:''}${hint}</span>${st}</div>`;
  };
  // Dois blocos independentes: 📝 a lista (pendentes) e 🧺 o que já foi comprado
  // para a refeição (lotes alocados c/ € + artigos comprados sem lote — um pedido
  // comprado cujo artigo tem lote é redundante: a linha do lote mostra qtd e €).
  // Pedidos COBERTOS pelo stock também saem dos pendentes: a linha do lote no
  // bloco Comprado já os representa; se a alocação for desfeita, voltam sozinhos.
  const pend=items.filter(it=>!shopIsBought(it)&&!shopIsCovered(it));
  // "Sem lote" = sem NENHUM lote do artigo em stock (não só os alocados a esta
  // refeição): se o admin mover a alocação para outra refeição, o pedido não
  // pode reaparecer aqui como "comprado" — os lotes são a fonte de verdade.
  const temLote=it=>stockArr().some(l=>stockBacked(l)&&(shopSameArtigo(l.artigo,it.artigo)||faturaScore(it.artigo,l.artigo)>=0.5));
  const bought=items.filter(it=>shopIsBought(it)&&!temLote(it));
  const nComp=alocs.length+bought.length;
  const det=(sub,lbl,cnt,body)=>{
    const k=key+sub;
    return `<details class="rdc-det msl-det"${MEAL_SHOP_OPEN[k]?' open':''} ontoggle="MEAL_SHOP_OPEN['${k}']=this.open">
      <summary><span class="rdc-lbl">${lbl}</span>${cnt?`<span class="msl-count">${cnt}</span>`:''}<span class="rdc-det-arrow">›</span></summary>
      <div class="rdc-det-body">${body}</div>
    </details>`;
  };
  const listaDet=(pend.length||canAdd)?det('|l',past?'📝 Não comprado':'🛒 Lista de compras',pend.length||'',
    (pend.length?pend.map(it=>lineOf(it,past)).join(''):'<div class="msl-empty">Ainda sem ingredientes nesta lista.</div>')+
    (canAdd?`<button class="cmp-mini prim write-action msl-add" onclick="openShopItemModal(null,'${rd.ref}','${rd.data}')">＋ Ingrediente</button>`:'')):'';
  const compDet=nComp?det('|c','🧺 Comprado',nComp,alocLines+bought.map(it=>lineOf(it,false)).join('')):'';
  return `<div class="rdc sf msl" onclick="event.stopPropagation()">${past?compDet+listaDet:listaDet+compDet}</div>`;
}

/* Depois de mexer na shoplist: refaz o separador Compras E os cartões das
   refeições (a lista por refeição vive lá). renderAll só refaz Compras quando
   é o tab ativo, daí o segundo passo. */
function renderShopViews(){
  if(CALC)renderAll();
  if(!CALC||TAB!=='compras')renderCompras();
}

// Ordenação do separador Shop List: 'ref' = agrupado por refeição/tipo (defeito);
// 'art' = lista plana por ordem alfabética de artigo. Fica memorizada no aparelho.
let SHOP_ORDER=(function(){try{return localStorage.getItem('festasbv_shop_order')||'ref';}catch(e){return 'ref';}})();
function setShopOrder(o){SHOP_ORDER=o;try{localStorage.setItem('festasbv_shop_order',o);}catch(e){}renderCompras();}

// Sub-separador ativo do Shop List: 'falta' | 'carrinho' | 'hist'. Memorizado
// no aparelho — quem anda nas compras volta a cair direto no carrinho.
let SHOP_TAB=(function(){try{const t=localStorage.getItem('festasbv_shop_tab');return['falta','carrinho','hist'].includes(t)?t:'falta';}catch(e){return 'falta';}})();
function setShopTab(t){SHOP_TAB=t;try{localStorage.setItem('festasbv_shop_tab',t);}catch(e){}renderCompras();}

function renderCompras(){
  const el=document.getElementById('view-compras');if(!el||!DATA)return;
  const items=shopArr();
  const act=items.filter(it=>!shopIsBought(it));          // tudo o que não está comprado
  const canW=shopCanWrite();
  const fechadas=contasFechadas();
  const ord={};SHOP_TIPOS.forEach((t,i)=>ord[t]=i);
  const byArt=SHOP_ORDER==='art';
  const byCat=SHOP_ORDER==='cat'&&CATS_TABLE;
  // Por categoria: agrupa por categoria de produto (sem categoria no fim) — a
  // vista "corredor do supermercado"; o badge fica para identificar o destino
  const catCmp=(a,b)=>{
    const ca=artCat(a.artigo),cb=artCat(b.artigo);
    return ((ca?0:1)-(cb?0:1))||(ca&&cb?ca.nome.localeCompare(cb.nome,'pt'):0);
  };
  const sortF=byCat
    ?(a,b)=>catCmp(a,b)||a.artigo.localeCompare(b.artigo,'pt')||(ord[a.tipo]-ord[b.tipo])||((a.dataValor||'').localeCompare(b.dataValor||''))
    :byArt
    ?(a,b)=>a.artigo.localeCompare(b.artigo,'pt')||(ord[a.tipo]-ord[b.tipo])||((a.dataValor||'').localeCompare(b.dataValor||''))
    :(a,b)=>(ord[a.tipo]-ord[b.tipo])||((a.dataValor||'').localeCompare(b.dataValor||''))||a.artigo.localeCompare(b.artigo,'pt');
  // Por artigo: lista plana com o badge da refeição em cada cartão
  const listOf=(arr,mineView)=>byCat?shopCatGroupedList(arr,mineView)
    :byArt?'<div class="cmp-list">'+arr.map(it=>shopItemCard(it,mineView,false)).join('')+'</div>'
    :shopGroupedList(arr,mineView);
  const mine=act.filter(shopMineOwn).sort(sortF);                                // a MINHA checklist pessoal (só o próprio, não o cônjuge; inclui removidos c/ alerta)
  const falta=act.filter(x=>!x.tratadoPor&&!shopIsRemoved(x)&&!shopIsCovered(x)).sort(sortF);  // livres, por tratar (e não cobertos pelo stock)
  const cobertos=act.filter(x=>!x.tratadoPor&&!shopIsRemoved(x)&&shopIsCovered(x)).sort(sortF);// pedidos satisfeitos pelo stock alocado — visíveis, mas sem nada a comprar
  const carrinhos=act.filter(x=>x.tratadoPor&&!shopIsRemoved(x)).sort(sortF);    // já no carrinho de alguém (incl. o meu — todos veem)
  const removidos=act.filter(x=>shopIsRemoved(x)&&!x.tratadoPor).sort(sortF);    // histórico de removidos

  let h='';
  h+=`<div class="cmp-hdr">
    <div class="cmp-hdr-title sf">🛒 Shop List</div>
    <button class="btn prim write-action" onclick="openShopItemModal()" ${canW?'':'disabled'}>＋ Artigo</button>
  </div>`;

  // ── Sub-separadores: Em falta · O Meu Carrinho · Histórico ──
  const nCompras=new Set((DATA.despesas||[]).filter(d=>d.compraId).map(d=>d.compraId)).size;
  const nHist=nCompras+removidos.length;
  const tabBtn=(id,ico,lbl,n)=>`<button class="cmp-tab${SHOP_TAB===id?' on':''}" onclick="setShopTab('${id}')"><span class="cmp-tab-ico">${ico}</span><span class="cmp-tab-lbl">${lbl}</span>${n?`<span class="cmp-tab-n">${n}</span>`:''}</button>`;
  h+=`<div class="cmp-tabs sf">
    ${tabBtn('falta','📝','Em falta',falta.length)}
    ${tabBtn('carrinho','🛒','Carrinho',mine.length)}
    ${tabBtn('hist','🕘','Histórico',nHist)}
  </div>`;

  // Ordenação só faz sentido nas listas ativas (no histórico manda a data).
  // No Histórico não há chips, mas mantém-se a mesma linha divisória dos outros
  // sub-separadores para o cabeçalho ficar coerente.
  if(SHOP_TAB!=='hist'){
    h+=`<div class="cmp-sort">
      <span class="sd-chip${(byArt||byCat)?'':' on'}" onclick="setShopOrder('ref')">📅 Por refeição</span>
      <span class="sd-chip${byArt?' on':''}" onclick="setShopOrder('art')">🔤 Por artigo</span>
      ${CATS_TABLE?`<span class="sd-chip${byCat?' on':''}" onclick="setShopOrder('cat')">🏷️ Por categoria</span>`:''}
    </div>`;
  }else{
    h+='<div class="cmp-divider"></div>';
  }

  if(SHOP_TAB==='falta'){
    // ── Em falta (livres, ninguém trata, não cobertos) ──
    if(!falta.length){
      h+=carrinhos.length
        ?'<div class="cmp-empty sf"><span class="cmp-empty-ico">🛒</span>Nada em falta — está tudo no carrinho de alguém 👇</div>'
        :cobertos.length
        ?'<div class="cmp-empty sf"><span class="cmp-empty-ico">🧺</span>Nada por comprar — o stock cobre o que está pedido 👇</div>'
        :'<div class="cmp-empty sf"><span class="cmp-empty-ico">🎉</span>A lista está vazia.<br>Toca em <b>＋ Artigo</b> para pedir o primeiro.</div>';
    }else{
      // Cabeçalho de estado + wrapper .cmp-free: distingue à vista o que ainda
      // não tem dono (fita campino) do que já está entregue (bloco verde abaixo)
      h+=`<div class="cmp-sec-hdr sf cmp-sec-falta">📣 Falta quem trate <span class="cmp-count">${falta.length}</span></div>`;
      h+='<div class="cmp-free">'+listOf(falta,false)+'</div>';
    }
    // ── Já em carrinhos (de qualquer pessoa — todos veem quem leva o quê) ──
    if(carrinhos.length){
      h+=`<div class="cmp-sec-hdr sf cmp-sec-claim" style="margin-top:22px">🛒 Já em carrinhos <span class="cmp-count">${carrinhos.length}</span></div>`;
      h+='<div class="cmp-claimed">'+listOf(carrinhos,false)+'</div>';
    }
    // ── Cobertos pelo stock (a necessidade mantém-se registada; se a alocação
    //    for desfeita, voltam sozinhos ao "Falta quem trate") ──
    if(cobertos.length){
      h+=`<div class="cmp-sec-hdr sf cmp-sec-stock" style="margin-top:22px">🧺 Cobertos pelo stock <span class="cmp-count">${cobertos.length}</span></div>`;
      h+='<div class="cmp-covered">'+listOf(cobertos,false)+'</div>';
      h+='<div class="note">Pedidos já satisfeitos pelo stock alocado às refeições — não há nada a comprar. Se a alocação mudar, voltam sozinhos a "Falta quem trate".</div>';
    }
  }else if(SHOP_TAB==='carrinho'){
    // ── O meu carrinho (artigos que disse que tratava) ──
    if(!mine.length){
      h+='<div class="cmp-empty sf"><span class="cmp-empty-ico">🛒</span>O teu carrinho está vazio.<br>Passa por <b>📝 Em falta</b> e toca em <b>Carrinho</b> nos artigos que fores buscar.</div>';
    }else{
      h+=listOf(mine,true);
    }
    if(fechadas){
      h+='<div class="empty sf" style="margin-top:10px">Contas fechadas — não é possível registar compras.</div>';
    }else{
      h+=`<button class="btn prim write-action" style="width:100%;margin-top:12px" onclick="openCompra(null)" ${canW?'':'disabled'}>💰 Registar compra</button>`;
    }
  }else{
    // ── Histórico: compras registadas + artigos removidos ──
    if(!nHist)h+='<div class="cmp-empty sf"><span class="cmp-empty-ico">🕘</span>Ainda sem histórico.<br>As compras registadas e os artigos removidos aparecem aqui.</div>';
    h+=renderComprados();
    h+=renderRemovidos(removidos,true);
  }

  el.innerHTML=h;
}

function renderRemovidos(removidos,open){
  if(!removidos.length)return '';
  const rows=removidos.map(it=>{
    const qtdTxt=shopQtyLabel(it);
    const badge=shopIsMeal(it.tipo)&&it.dataValor?`${shopTipoIcon(it.tipo)} ${fmtDiaMes(it.dataValor)}`:`${shopTipoIcon(it.tipo)} ${it.tipo}`;
    const acts=`<div class="cmp-rm-acts write-action">
      <button class="cmp-mini" onclick="restoreShopItem(${it._id})">↩︎ Repor</button>
      ${isAdmin()?`<button class="cmp-mini" onclick="purgeShopItem(${it._id})">✕</button>`:''}
    </div>`;
    return `<div class="cmp-done-card cmp-rm">
      <div class="cmp-done-top"><b>${escHtml(it.artigo)}${qtdTxt?' <i class="cmp-rm-qtd">'+escHtml(qtdTxt)+'</i>':''}</b><span class="cmp-done-meta">${badge}</span></div>
      <div class="cmp-rm-meta">pedido por ${escHtml(it.criadoPor||'?')} · removido por ${escHtml(it.cfDesc||'?')}</div>
      ${acts}
    </div>`;
  }).join('');
  return `<div class="cmp-done-hdr sf${open?' open':''}" onclick="this.nextElementSibling.classList.toggle('open');this.classList.toggle('open')">
      <span>🗑️ Removidos <span class="cmp-count">${removidos.length}</span></span><span class="cmp-chev">▾</span></div>
    <div class="cmp-done-body${open?' open':''}">${rows}</div>`;
}

/* ═══ SEPARADOR STOCK — gestão global (mover artigos entre refeições/tipos) ═══
   Agrupa os lotes por artigo, mostra a alocação agregada + o livre, e permite
   abrir cada lote para mover a alocação (refeição ↔ tipo), sem reabrir faturas.
   Só edita stock_lote.alocacoes → o calcular() re-deriva as contas. */
// Em contas fechadas o stock não se gere — o separador desaparece
function updateStockTabVis(){const t=document.getElementById('tab-stock');if(t)t.style.display=(STOCK_TABLE&&!contasFechadas())?'':'none';}

// Agrega as alocações de um conjunto de lotes por destino + o livre (por alocar)
function stockAggAlocs(lotes){
  const dest={};let freeQ=0,freeV=0,totQ=0,totV=0,u='';
  lotes.forEach(l=>{
    u=u||l.unidade;const unit=l.qtd>0?l.valor/l.qtd:0;
    totQ=rnd(totQ+l.qtd,3);totV=rnd(totV+(+l.valor||0),2);
    let aloc=0;
    (l.alocacoes||[]).forEach(a=>{const q=+a.qtd||0;if(q<=0)return;aloc=rnd(aloc+q,3);const k=alocToDestino(a);(dest[k]=dest[k]||{qtd:0,val:0});dest[k].qtd=rnd(dest[k].qtd+q,3);dest[k].val=rnd(dest[k].val+unit*q,2);});
    const lf=rnd(l.qtd-aloc,3);if(lf>0){freeQ=rnd(freeQ+lf,3);freeV=rnd(freeV+unit*lf,2);}
  });
  return {dest,freeQ,freeV,totQ,totV,u};
}
// Dia da semana abreviado a 3 letras (Sáb, Dom, Sex, …) para rótulos compactos
function diaAbrev(ds){const s=diaCurto(ds);return s?s.slice(0,3):'';}
function stockDestChip(k,qtd,u){
  const a=destinoAloc(k,qtd);if(!a)return '';
  const meal=alocIsMeal(a);
  const ic=shopTipoIcon(a.tipo);
  const lbl=meal?`${diaAbrev(a.data)} ${fmtDiaMes(a.data)}`:a.tipo;
  return `<span class="stk-chip">${ic} ${escHtml(lbl)} · ${escHtml(fmtQty(qtd,u))}</span>`;
}
// Cartão minimal: nome + chips (refeições por ordem do calendário, com a qtd
// à frente; a sobra ganha o badge "a sobrar"). As compras de origem e o total
// em € vivem no detalhe — toca-se no cartão para o abrir.
function stockArticleCard(g){
  const ag=stockAggAlocs(g.lotes);
  const dests=Object.keys(ag.dest).sort(destKeyCmp);
  const chips=dests.map(k=>stockDestChip(k,ag.dest[k].qtd,ag.u)).join('')
    +(ag.freeQ>0?`<span class="stk-chip livre">🧺 a sobrar · ${escHtml(fmtQty(ag.freeQ,ag.u))}</span>`:'');
  return `<div class="stk-card stk-tap" onclick="openLoteModal(${g.lotes[0]._id})">
    <div class="stk-card-top"><b>${escHtml(g.artigo)}</b><span class="stk-chev">›</span></div>
    <div class="stk-chips">${chips}</div>
  </div>`;
}
// Filtro do separador Stock por tipologia de destino ('all' | 'Gerais' | …).
// Só vive na sessão — ao reabrir a app volta a "Tudo".
let STOCK_FILTER='all';
// Containers de categoria abertos/fechados (só na sessão; abertos por defeito)
const STOCK_CAT_OPEN={};
function setStockFilter(f){STOCK_FILTER=f;renderStock();}
// Tipologias em que um artigo toca: destinos das alocações + bolsa comum
// (o que está por alocar cai no pool Gerais)
function stockGroupTipos(ag){
  const s=new Set();
  Object.keys(ag.dest).forEach(k=>{const a=destinoAloc(k,0);if(a)s.add(a.tipo);});
  if(ag.freeQ>0)s.add('Gerais');
  return s;
}
function renderStock(){
  const el=document.getElementById('view-stock');if(!el||!DATA)return;
  if(!STOCK_TABLE){el.innerHTML='<div class="empty sf">Stock indisponível.</div>';return;}
  const lots=stockArr().filter(stockBacked);
  const groups={};
  lots.forEach(l=>{const k=shopArtKey(l.artigo);(groups[k]=groups[k]||{artigo:l.artigo,lotes:[]}).lotes.push(l);});
  const arr=Object.values(groups).sort((a,b)=>a.artigo.localeCompare(b.artigo,'pt'))
    .map(g=>Object.assign(g,{tipos:stockGroupTipos(stockAggAlocs(g.lotes))}));
  const canEdit=isAdmin();
  // ✨: pedir à AI categorias para o que ainda não tem (só admin, com migração)
  const aiBtn=(CATS_TABLE&&canEdit&&catNamesPorCategorizar().length)
    ?`<button class="btn write-action" id="stk-catsug-btn" onclick="catSugerir()">✨ Categorias</button>`:'';
  let h=`<div class="cmp-hdr"><div class="cmp-hdr-title sf">🧺 Gestão de Stock</div>${aiBtn}</div>`;
  h+=`<div class="note" style="margin-top:2px;margin-bottom:8px">${canEdit?'Toca num artigo para o alocar às refeições e categorias — as contas recalculam sozinhas.':'Toca num artigo para ver como está alocado às refeições e categorias.'}</div>`;
  if(!arr.length){el.innerHTML=h+'<div class="empty sf">Ainda não há stock. Regista uma compra itemizada ou importa uma fatura.</div>';return;}
  // Chips de filtro: ícones abreviados, só as tipologias com artigos
  const FILTROS=[['Gerais','🧾'],['Bebidas','🥤'],['Cerveja','🍺'],['Almoço','☀️'],['Jantar','🌙']].filter(([t])=>arr.some(g=>g.tipos.has(t)));
  if(STOCK_FILTER!=='all'&&!FILTROS.some(([t])=>t===STOCK_FILTER))STOCK_FILTER='all';
  if(FILTROS.length>1)h+=`<div class="cmp-sort stk-filter">
    <span class="sd-chip txt${STOCK_FILTER==='all'?' on':''}" onclick="setStockFilter('all')">Tudo</span>
    ${FILTROS.map(([t,ic])=>`<span class="sd-chip${STOCK_FILTER===t?' on':''}" onclick="setStockFilter('${t}')"><i>${ic}</i><small>${t}</small></span>`).join('')}
  </div>`;
  const vis=STOCK_FILTER==='all'?arr:arr.filter(g=>g.tipos.has(STOCK_FILTER));
  if(!vis.length)h+='<div class="empty sf">Sem artigos nesta tipologia.</div>';
  else if(!CATS_TABLE)h+=vis.map(g=>stockArticleCard(g)).join('');
  else{
    // Containers por categoria de produto (Sumos, Talho, …), colapsáveis; os
    // sem categoria caem em "Outros", sempre no fim. O cabeçalho resume o
    // container: ícone + nº de artigos + € total em stock dessa categoria.
    vis.sort((a,b)=>{
      const ca=artCat(a.artigo),cb=artCat(b.artigo);
      return ((ca?0:1)-(cb?0:1))||(ca&&cb?ca.nome.localeCompare(cb.nome,'pt'):0)||a.artigo.localeCompare(b.artigo,'pt');
    });
    const secs={},order=[];
    vis.forEach(g=>{
      const c=artCat(g.artigo);const k=c?'c'+c.id:'none';
      if(!secs[k]){secs[k]={cat:c,groups:[]};order.push(k);}
      secs[k].groups.push(g);
    });
    // Garantia explícita: "Outros" fecha sempre a lista, aconteça o que
    // acontecer ao sort acima
    if(secs.none&&order[order.length-1]!=='none'){order.splice(order.indexOf('none'),1);order.push('none');}
    h+=order.map(k=>{
      const s=secs[k];
      const nome=s.cat?s.cat.nome:'Outros';
      const totV=rnd(s.groups.reduce((a,g)=>a+stockAggAlocs(g.lotes).totV,0),2);
      const open=STOCK_CAT_OPEN[k]!==false;   // aberto por defeito; fecho é da sessão
      return `<details class="stk-cat${s.cat?'':' stk-cat-outros'}"${open?' open':''} ontoggle="STOCK_CAT_OPEN['${k}']=this.open">
        <summary class="stk-cat-sum">
          <span class="stk-cat-ico">${catEmoji(nome)}</span>
          <span class="stk-cat-nome sf">${escHtml(nome)}</span>
          <span class="stk-cat-n">${s.groups.length}</span>
          <span class="stk-cat-val">${eur(totV)}</span>
          <span class="stk-cat-arrow">▾</span>
        </summary>
        <div class="stk-cat-body">${s.groups.map(g=>stockArticleCard(g)).join('')}</div>
      </details>`;
    }).join('');
  }
  el.innerHTML=h;
}

/* Cartões das compras registadas (Histórico): uma linha por compra — onde,
   quando, total. O detalhe (linhas por tipo/refeição) vive no openCompra. */
function renderComprados(){
  const withC=(DATA.despesas||[]).filter(d=>d.compraId);
  if(!withC.length)return '';
  const groups={};
  withC.forEach(d=>{(groups[d.compraId]=groups[d.compraId]||[]).push(d);});
  const cards=Object.keys(groups).map(cid=>{
    const ds=groups[cid];
    const total=rnd(ds.reduce((a,d)=>a+(+d.valor||0),0),2);
    const desc=(ds.find(d=>d.desc&&d.desc!=='Compras')||ds[0]).desc||'Compra';
    const date=ds.map(d=>d.dataDesp).filter(Boolean).sort()[0]||'';
    return {cid,date,html:`<div class="cmp-done-card" onclick="openCompra('${cid}')">
      <div class="cmp-done-top"><b>${escHtml(desc)}</b><span class="cmp-done-meta">${date?fmtDiaMes(date)+' · ':''}<b class="cmp-done-tot">${eur(total)}</b></span><span class="stk-chev">›</span></div>
    </div>`};
  }).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  return '<div class="cmp-list" style="margin-top:2px">'+cards.map(c=>c.html).join('')+'</div>';
}

/* ── Detalhe / Adicionar / Editar artigo ──
   Tocar num artigo abre o detalhe (editar/eliminar só aqui, e só para o autor
   ou o admin). O botão "＋ Artigo" abre em modo de criação. */
let editingItemId=null;
// presetTipo/presetData: criação a partir do cartão de uma refeição (tab
// Refeições) — o artigo nasce logo ligado a esse Almoço/Jantar. Nesse contexto
// o tipo e a refeição ficam trancados: mostra-se só a refeição de destino.
let shopCtxLock=null;
function openShopItemModal(id,presetTipo,presetData){
  const it=id!=null?shopArr().find(x=>x._id===id):null;
  if(id!=null&&!it){toast('Artigo não encontrado','bad');return;}
  // Criar exige permissão de escrita; abrir o detalhe de um artigo é livre
  if(!it&&!shopCanWrite()){toast('Sem permissão','bad');return;}
  editingItemId=id||null;
  shopCtxLock=(!it&&presetTipo&&shopIsMeal(presetTipo)&&presetData)?{tipo:presetTipo,data:presetData}:null;
  const canEdit=it?shopCanEditItem(it):true;   // criação = pode
  document.getElementById('shop-item-title').textContent=it?(canEdit?'Editar Artigo':'Detalhe do Artigo'):(shopCtxLock?'Adicionar Ingrediente':'Adicionar Artigo');
  document.getElementById('shop-artigo').value=it?it.artigo:'';
  document.getElementById('shop-qtd').value=it?normalizeQty(it.quantidade):'';
  document.getElementById('shop-tam').value=it?(it.tamanho||''):'';
  document.getElementById('shop-tipo').value=it?it.tipo:(presetTipo||'Gerais');
  // Contexto de refeição trancado: esconde tipo+refeições e mostra o destino fixo
  document.getElementById('shop-tipo-wrap').style.display=shopCtxLock?'none':'';
  const ctxBox=document.getElementById('shop-ctx-lock');
  if(shopCtxLock){
    ctxBox.innerHTML=`<span class="scl-ico">🔒</span><span>${escHtml(shopGroupLabel(shopCtxLock.tipo,shopCtxLock.data))}</span>`;
    ctxBox.style.display='';
  }else ctxBox.style.display='none';
  shopTipoChanged();
  if(it&&shopIsMeal(it.tipo))document.getElementById('shop-ref').value=it.dataValor||'';
  else if(!it&&!shopCtxLock&&presetTipo&&shopIsMeal(presetTipo)&&presetData){
    const cb=document.querySelector(`#shop-ref-multi input[value="${presetData}"]`);if(cb)cb.checked=true;
  }
  // Meta: quem pediu / quem trata / removido — visível para todos no detalhe
  const meta=document.getElementById('shop-meta');
  if(it){
    const mm=[];
    if(it.criadoPor)mm.push(`📝 Pedido por <b>${escHtml(it.criadoPor)}</b>${it.criadoEm?' · '+fmtDiaMes(String(it.criadoEm).slice(0,10)):''}`);
    if(it.tratadoPor)mm.push(`🛒 No carrinho de <b>${escHtml(it.tratadoPor)}</b>${shopMine(it)&&it.noCarrinho?' · ✅ já apanhado':''}`);
    if(shopIsRemoved(it))mm.push(`⚠️ Removido da lista por <b>${escHtml(it.cfDesc||'?')}</b>`);
    meta.innerHTML=mm.join('<br>');meta.style.display=mm.length?'':'none';
  }else meta.style.display='none';
  // Reatribuir "quem trata": só o admin pode puxar/passar um artigo reclamado
  const claimWrap=document.getElementById('shop-claim-wrap');
  if(it&&isAdmin()){
    let opts='<option value="">— ninguém —</option>';
    const nomes=CALC?CALC.membros.map(m=>m.nome):[];
    if(it.tratadoPor&&!nomes.includes(it.tratadoPor))opts+=`<option value="${escHtml(it.tratadoPor)}" selected>${escHtml(it.tratadoPor)}</option>`;
    nomes.forEach(n=>{opts+=`<option value="${escHtml(n)}"${it.tratadoPor===n?' selected':''}>${escHtml(n)}</option>`;});
    document.getElementById('shop-claim').innerHTML=opts;
    claimWrap.style.display='';
  }else claimWrap.style.display='none';
  // "Eu trato de comprar" só na criação (na edição a posse gere-se por claim/largar)
  const euRow=document.getElementById('shop-eutrato-row');
  if(euRow){
    euRow.style.display=it?'none':'flex';
    document.getElementById('shop-eutrato').checked=false;
    _setEutratoKnob(false);
  }
  // Campos editáveis só quem pode; senão, detalhe em leitura
  document.querySelectorAll('#shop-item-modal input,#shop-item-modal select').forEach(el=>{el.disabled=!canEdit;el.style.opacity=canEdit?'':'.75';});
  shopCatSync();   // depois do disable geral: a categoria tem regras próprias
  const saveBtn=document.getElementById('shop-item-save');
  saveBtn.textContent=it?'Guardar':'Adicionar';
  saveBtn.style.display=canEdit?'':'none';
  const delBtn=document.getElementById('shop-item-del');
  // Remover = soft-delete (autor ou admin); num artigo já removido só o admin apaga de vez
  const canDel=it&&canEdit&&(!shopIsRemoved(it)||isAdmin());
  delBtn.style.display=canDel?'':'none';
  delBtn.textContent=it&&shopIsRemoved(it)?'Apagar de vez':'Remover';
  const restBtn=document.getElementById('shop-item-restore');
  restBtn.style.display=(it&&shopIsRemoved(it)&&shopCanWrite())?'':'none';
  // Largar (só quem está a tratar) — no cartão só fica a bolinha do carrinho
  document.getElementById('shop-item-unclaim').style.display=(it&&shopMine(it))?'':'none';
  document.getElementById('shop-item-bg').classList.add('show');
  document.body.classList.add('no-scroll');
  if(!it)setTimeout(()=>document.getElementById('shop-artigo').focus(),50);
}
function deleteShopItemFromModal(){if(editingItemId!=null){const id=editingItemId;closeShopItemModal();deleteShopItem(id);}}
function closeShopItemModal(){document.getElementById('shop-item-bg').classList.remove('show');document.body.classList.remove('no-scroll');editingItemId=null;shopCtxLock=null;}
function _setEutratoKnob(on){
  const knob=document.getElementById('shop-eutrato-knob');
  const track=knob?.previousElementSibling;
  if(knob)knob.style.left=on?'22px':'2px';
  if(track)track.style.background=on?'var(--gold)':'var(--line)';
}
function shopTipoChanged(){
  const tipo=document.getElementById('shop-tipo').value;
  const wrap=document.getElementById('shop-ref-wrap');
  // Refeição trancada pelo contexto → não há nada a escolher aqui
  if(shopCtxLock){wrap.style.display='none';return;}
  wrap.style.display=shopIsMeal(tipo)?'':'none';
  if(!shopIsMeal(tipo))return;
  // Criação → checkboxes (pode marcar várias refeições de uma vez); edição →
  // select (um artigo pertence a UMA refeição — para outra cria-se outro registo)
  const creating=editingItemId==null;
  document.getElementById('shop-ref-lbl').textContent=creating?'Refeições a que se destina (podes marcar várias)':'Refeição a que se destina';
  document.getElementById('shop-ref').style.display=creating?'none':'';
  const multi=document.getElementById('shop-ref-multi');
  multi.style.display=creating?'':'none';
  if(creating)multi.innerHTML=shopMealChecks(tipo);
  else document.getElementById('shop-ref').innerHTML=shopMealOptions(tipo,'');
}
/* Categoria no detalhe do artigo: mostra a associação do nome escrito e
   deixa preencher (qualquer membro) ou alterar (só admin). Corre DEPOIS do
   disable geral do modal — um detalhe em leitura fica em leitura. */
function shopCatSync(){
  const wrap=document.getElementById('shop-cat-wrap');if(!wrap)return;
  if(!CATS_TABLE){wrap.style.display='none';return;}
  wrap.style.display='';
  const sel=document.getElementById('shop-cat');
  const note=document.getElementById('shop-cat-note');
  const artigo=(document.getElementById('shop-artigo').value||'').trim();
  const m=ART_CATS[shopArtKey(artigo)];
  sel.innerHTML=catOptionsHtml(m?m.catId:null);
  const locked=!!(m&&!isAdmin());
  if(locked&&!sel.disabled){sel.disabled=true;sel.style.opacity='.75';}
  note.textContent='Categoria já definida — só o admin a altera.';
  note.style.display=locked?'':'none';
}
async function saveShopItem(){
  if(!DATA._sbId){toast('Sem ligação — recarrega a página','bad');return;}
  const artigo=(document.getElementById('shop-artigo').value||'').trim();
  const qtd=normalizeQty(document.getElementById('shop-qtd').value);
  const tam=normalizeQty(document.getElementById('shop-tam').value);
  const tipo=shopCtxLock?shopCtxLock.tipo:document.getElementById('shop-tipo').value;
  if(!artigo){toast('Indica o artigo','bad');return;}
  let dataValor=null,datasMulti=null;
  if(shopIsMeal(tipo)){
    if(editingItemId!=null){
      dataValor=document.getElementById('shop-ref').value||'';
      if(!dataValor){toast('Escolhe a refeição (ou define-a em Refeições)','bad');return;}
    }else if(shopCtxLock){
      datasMulti=[shopCtxLock.data];
    }else{
      datasMulti=[...document.querySelectorAll('#shop-ref-multi input:checked')].map(c=>c.value);
      if(!datasMulti.length){toast('Marca pelo menos uma refeição (ou define-a em Refeições)','bad');return;}
    }
  }
  const btn=document.getElementById('shop-item-save');btn.disabled=true;
  setSync('load','a guardar…');
  try{
    if(editingItemId!=null){
      const it=shopArr().find(x=>x._id===editingItemId);
      const patch={artigo,quantidade:qtd,tamanho:tam||null,tipo,data_valor:dataValor};
      const local={artigo,quantidade:qtd,tamanho:tam,tipo,dataValor};
      // Admin pode reatribuir quem trata (puxar/largar por outrem)
      if(it&&isAdmin()&&document.getElementById('shop-claim-wrap').style.display!=='none'){
        const nv=document.getElementById('shop-claim').value||null;
        if(nv!==(it.tratadoPor||null)){patch.tratado_por=nv;patch.no_carrinho=false;local.tratadoPor=nv;local.noCarrinho=false;}
      }
      await queueWrite(()=>sbReq('PATCH',`shoplist?id=eq.${editingItemId}`,patch));
      if(it)Object.assign(it,local);
      toast('Artigo atualizado ✓','ok');
    }else{
      const criadoPor=myPrimaryName()||(isAdmin()?'Admin':'');
      // "Eu trato": quem adiciona fica logo a tratar; senão fica "Em falta" e
      // os outros são avisados no Telegram (routing na Edge Function notif-pessoais)
      const tratoEu=!!document.getElementById('shop-eutrato').checked;
      // Uma refeição = um registo: marcar várias refeições cria um artigo por
      // refeição (cada uma mantém a sua lista e o custo cai no sítio certo)
      const rows=(datasMulti||[dataValor]).map(dv=>{
        const r={evento_id:DATA._sbId,artigo,quantidade:qtd,tamanho:tam||null,tipo,data_valor:dv,estado:'pendente',criado_por:criadoPor};
        if(tratoEu)r.tratado_por=criadoPor;
        return r;
      });
      const ins=await queueWrite(()=>sbReq('POST','shoplist',rows,{Prefer:'return=representation'}));
      rows.forEach((r,i)=>{
        shopArr().push({_id:ins&&ins[i]?ins[i].id:null,artigo,quantidade:qtd,tamanho:tam,tipo,dataValor:r.data_valor,estado:'pendente',tratadoPor:tratoEu?criadoPor:null,noCarrinho:false,compraId:null,cfDesc:null,valor:null,criadoPor,criadoEm:new Date().toISOString(),compradoEm:null});
        sbLog('compras','adicionou',artigo,{tratoEu,quantidade:shopQtyLabel({quantidade:qtd,tamanho:tam}),tipoDesp:tipo,dataValor:r.data_valor,dia:r.data_valor?dataToDia(r.data_valor):undefined,ref:shopIsMeal(tipo)?tipo:undefined});
      });
      toast(rows.length>1?`Artigo adicionado a ${rows.length} refeições ✓`:'Artigo adicionado ✓','ok');
    }
    // Categoria do artigo (associação global por nome) — em paralelo, não
    // bloqueia o artigo; catUserSetMapping aplica as regras e trata erros
    if(CATS_TABLE){
      const csel=document.getElementById('shop-cat');
      if(csel&&!csel.disabled)catUserSetMapping(artigo,parseInt(csel.value)||null);
    }
    syncMirror();marcaGuardado();
    btn.disabled=false;closeShopItemModal();renderShopViews();
  }catch(e){setSync('err','erro ao guardar');btn.disabled=false;toast(permErrorMsg(e),'bad');}
}

/* ── Marcações (tratar / carrinho / largar / remover) ── */
async function _shopUpdate(id,patch,local){
  const it=shopArr().find(x=>x._id===id);if(!it)return;
  setSync('load','a guardar…');
  try{
    await queueWrite(()=>sbReq('PATCH',`shoplist?id=eq.${id}`,patch));
    Object.assign(it,local);syncMirror();marcaGuardado();renderShopViews();
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');}
}
async function claimItem(id){
  const it=shopArr().find(x=>x._id===id);if(!it)return;
  if(it.tratadoPor&&!shopMine(it)){toast(`Já está a ser tratado por ${it.tratadoPor}`,'bad');return;}
  const nome=myPrimaryName()||(isAdmin()?'Admin':'');
  setSync('load','a guardar…');
  try{
    // Anti-corrida: só reclama se no servidor ainda estiver livre — ninguém
    // "rouba" um artigo que outro reclamou entretanto (só o próprio larga).
    const res=await queueWrite(()=>sbReq('PATCH',`shoplist?id=eq.${id}&tratado_por=is.null`,{tratado_por:nome},{Prefer:'return=representation'}));
    if(res&&res.length){Object.assign(it,{tratadoPor:nome});await claimSameElsewhere(it,nome);}
    else{
      const rows=await sbReq('GET',`shoplist?id=eq.${id}&select=tratado_por,no_carrinho,estado`);
      if(rows&&rows[0])Object.assign(it,{tratadoPor:rows[0].tratado_por||null,noCarrinho:!!rows[0].no_carrinho,estado:rows[0].estado||it.estado});
      toast(it.tratadoPor?`Entretanto ficou ${it.tratadoPor} a tratar`:'Não foi possível reclamar o artigo','bad');
    }
    syncMirror();marcaGuardado();renderShopViews();
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');}
}
/* "Eu trato" em bloco: se o mesmo artigo (nome igual, sem acentos/maiúsculas)
   estiver livre noutras refeições/tipos, propõe levar tudo na mesma ida — o
   caso típico "trago logo as batatas de hoje e de amanhã". Quem quiser manter
   compradores separados ignora a sugestão; cada registo continua independente. */
function shopArtKey(s){return (s||'').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');}
function shopSameArtigo(a,b){return shopArtKey(a)===shopArtKey(b);}
async function claimSameElsewhere(it,nome){
  const others=shopArr().filter(x=>x._id!==it._id&&x._id!=null&&!x.tratadoPor&&shopIsPending(x)&&!shopIsCovered(x)&&shopGroupKey(x)!==shopGroupKey(it)&&shopSameArtigo(x.artigo,it.artigo));
  if(!others.length)return;
  const lst=others.map(o=>{const q=shopQtyLabel(o);return `• ${shopGroupLabel(o.tipo,o.dataValor)}${q?' — '+q:''}`;}).join('\n');
  if(!confirm(`"${it.artigo}" também está em falta em:\n\n${lst}\n\nLevas também?`))return;
  // Mesma guarda anti-corrida do claim simples: só leva os que ainda estão livres
  const ids=others.map(o=>o._id);
  const res=await queueWrite(()=>sbReq('PATCH',`shoplist?id=in.(${ids.join(',')})&tratado_por=is.null`,{tratado_por:nome},{Prefer:'return=representation'}));
  const got=new Set((res||[]).map(r=>r.id));
  others.forEach(o=>{if(got.has(o._id))o.tratadoPor=nome;});
  if(got.size<others.length)toast('Alguns já tinham ficado com outra pessoa','bad');
}
function unclaimItem(id){
  const it=shopArr().find(x=>x._id===id);if(!it)return;
  if(!shopMine(it)&&!isAdmin()){toast('Só quem está a tratar pode largar o artigo','bad');return;}
  _shopUpdate(id,{tratado_por:null,no_carrinho:false},{tratadoPor:null,noCarrinho:false});
}
function toggleCart(id){
  const it=shopArr().find(x=>x._id===id);if(!it)return;
  if(!shopMine(it)&&!isAdmin())return;   // o carrinho é pessoal de quem trata
  const v=!it.noCarrinho;_shopUpdate(id,{no_carrinho:v},{noCarrinho:v});
}
async function deleteShopItem(id){
  const it=shopArr().find(x=>x._id===id);if(!it)return;
  if(!shopCanEditItem(it)){toast('Só quem pediu o artigo (ou o admin) o pode remover','bad');return;}
  if(shopIsRemoved(it)){purgeShopItem(id);return;}   // já no histórico → apagar de vez (admin)
  const aviso=it.tratadoPor&&!shopMine(it)?`\n\nAtenção: ${it.tratadoPor} está a tratar dele — vai continuar a vê-lo com um alerta até o largar.`:'';
  if(!confirm(`Remover "${it.artigo}" da lista?${aviso}\n\n(Fica no histórico de Removidos, de onde pode ser reposto.)`))return;
  const quem=myPrimaryName()||(isAdmin()?'Admin':'');
  _shopUpdate(id,{estado:'removido',cf_desc:quem},{estado:'removido',cfDesc:quem});
}
function restoreShopItem(id){
  const it=shopArr().find(x=>x._id===id);if(!it||!shopIsRemoved(it))return;
  if(!shopCanWrite()){toast('Sem permissão','bad');return;}
  _shopUpdate(id,{estado:'pendente',cf_desc:null},{estado:'pendente',cfDesc:null});
}
function restoreShopItemFromModal(){if(editingItemId!=null){const id=editingItemId;closeShopItemModal();restoreShopItem(id);}}
function unclaimItemFromModal(){if(editingItemId!=null){const id=editingItemId;closeShopItemModal();unclaimItem(id);}}
async function purgeShopItem(id){   // apagar definitivamente do histórico (só admin)
  const it=shopArr().find(x=>x._id===id);if(!it)return;
  if(!isAdmin()){toast('Só o admin pode apagar definitivamente','bad');return;}
  if(!confirm(`Apagar definitivamente "${it.artigo}"?`))return;
  setSync('load','a guardar…');
  try{
    await queueWrite(()=>sbReq('DELETE',`shoplist?id=eq.${id}`));
    DATA.shoplist=shopArr().filter(x=>x._id!==id);syncMirror();marcaGuardado();renderShopViews();
    toast('Artigo apagado','ok');
  }catch(e){setSync('err','erro ao guardar');toast(permErrorMsg(e),'bad');}
}

/* ── Registar / Editar compra ──────────────────────────────────────────
   Estado: compraEdit = { id, lines:[{tipo,dataValor,valor,obs}] }.
   Os artigos escolhidos (picker) são marcados como comprados e ligados ao
   mesmo compra_id; cada linha vira uma despesa. */
let compraEdit={id:null,lines:[],lotes:[],det:false};
function openCompra(compraId){
  if(!shopCanWrite()){toast('Sem permissão','bad');return;}
  if(contasFechadas()&&!compraId){toast('Contas fechadas — só pagamentos de dívidas','bad');return;}
  const isEdit=!!compraId;
  // det = "preço por artigo" (defeito nas compras novas): preenche-se qtd+€ por
  // artigo e as linhas de despesa geram-se sozinhas. Na edição abre no separador
  // que corresponde ao que a compra tem (lotes → por artigo; senão por totais) —
  // os dois tabuladores ficam disponíveis e AMBAS as partes são gravadas.
  compraEdit={id:compraId||null,lines:[],lotes:[],det:!isEdit||stockArr().some(l=>l.compraId===compraId)};
  const linked=isEdit?shopArr().filter(x=>x.compraId===compraId):[];
  // Linhas: (edição) reconstruídas das despesas da compra; (nova) semeadas dos meus artigos
  if(isEdit){
    // A linha "🧺 Stock" não é editável à mão — é regenerada a partir dos lotes
    (DATA.despesas||[]).filter(d=>d.compraId===compraId&&!(d.tipo==='Gerais'&&(d.obs||'')===STOCK_OBS)).forEach(d=>{
      compraEdit.lines.push({tipo:d.tipo,dataValor:d.dataValor||null,valor:d.valor,obs:d.obs||''});
    });
    // Lotes já gravados desta compra: reconstrói destino/split das alocações
    // (1 alocação → destino simples; várias → split; nenhuma → por alocar).
    compraEdit.lotes=stockArr().filter(l=>l.compraId===compraId).map(l=>{
      const al=(l.alocacoes||[]).filter(a=>+a.qtd>0);
      // Liga o lote ao artigo da lista: nome igual ou, se a fatura o renomeou
      // (o talão manda no nome), por semelhança — guarda-se em _listArt
      const link=linked.find(x=>shopSameArtigo(x.artigo,l.artigo))||linked.find(x=>faturaScore(x.artigo,l.artigo)>=0.5);
      const base={_id:l._id,artigo:l.artigo,_listArt:link?link.artigo:null,qtd:fmtQty(l.qtd,l.unidade),valor:l.valor,keys:[],free:!link,destino:'',splits:null};
      if(al.length>1)base.splits=al.map(a=>({destino:alocToDestino(a),qtd:a.qtd}));
      else if(al.length===1)base.destino=alocToDestino(al[0]);
      return base;
    });
  }
  // Compra nova: as linhas semeiam-se dos artigos MARCADOS no picker (ver
  // compraSeedLines, chamada depois de o picker existir no DOM)
  if(isEdit&&!compraEdit.lines.length)compraEdit.lines.push({tipo:'Gerais',dataValor:null,valor:'',obs:''});

  // Cabeçalho
  document.getElementById('shop-buy-title').textContent=isEdit?'Editar Compra':'Registar Compra';
  document.getElementById('shop-buy-save').textContent=isEdit?'Guardar':'Registar compra';
  // Editar/apagar uma compra já registada mexe em despesas → só admin (as despesas
  // não têm policy de self-update/delete). Criar uma compra nova é permitido a membros.
  const ro=isEdit&&!isAdmin();
  document.getElementById('shop-buy-del').style.display=(isEdit&&isAdmin())?'':'none';
  document.getElementById('shop-buy-save').style.display=ro?'none':'';
  const who0=isEdit?((DATA.despesas.find(d=>d.compraId===compraId)||{}).quem||myPrimaryName()):myPrimaryName();
  document.getElementById('shop-buy-who').innerHTML=isAdmin()?memberOptions(who0):myMemberOptions(who0);
  const date0=isEdit?((DATA.despesas.find(d=>d.compraId===compraId)||{}).dataDesp||new Date().toISOString().slice(0,10)):new Date().toISOString().slice(0,10);
  document.getElementById('shop-buy-date').value=date0;
  const desc0=isEdit?((DATA.despesas.find(d=>d.compraId===compraId&&d.desc&&d.desc!=='Compras')||{}).desc||''):'';
  document.getElementById('shop-buy-desc').value=desc0;
  shopBuyDescCount();
  // Importar fatura: só em compras novas (na edição não há pré-preenchimento)
  const ocr=document.getElementById('shop-buy-ocr');
  if(ocr)ocr.style.display=isEdit?'none':'';

  // Picker de artigos (pendentes + removidos que eu ainda reclamo)
  const pend=shopArr().filter(x=>shopIsPending(x)||(shopIsRemoved(x)&&shopMine(x)));
  const pickItems=isEdit?linked.concat(pend.filter(x=>x.compraId!==compraId)):pend;
  // O picker vive num bloco recolhível DEPOIS do detalhe por artigo (junto ao
  // "＋ Artigo fora da lista") — abre sozinho quando ainda nada está marcado.
  let pl='';
  if(pickItems.length){
    // Compra nova: pré-marca só os artigos que já pus no carrinho físico (o ✓
    // verde na aba Carrinho, noCarrinho). Se não marquei nenhum, cai para "todos
    // os meus" (comportamento antigo) para o picker não abrir vazio. Os restantes
    // ficam listados mas por marcar — dá para os juntar à mão. Na edição: os que
    // já estão ligados a esta compra.
    const mineOwn=pickItems.filter(it=>shopMineOwn(it));
    const anyCart=mineOwn.some(it=>it.noCarrinho);
    const defOn=it=>shopMineOwn(it)&&(!anyCart||it.noCarrinho);
    const nOn=pickItems.filter(it=>isEdit?it.compraId===compraId:defOn(it)).length;
    let rows='';
    pickItems.slice().sort((a,b)=>a.artigo.localeCompare(b.artigo,'pt')).forEach(it=>{
      const on=isEdit?it.compraId===compraId:defOn(it);
      const ql=shopQtyLabel(it);
      rows+=`<label class="cmp-pick-row"><input type="checkbox" class="shop-pick" value="${it._id}" ${on?'checked':''} onchange="compraPickChanged()">
        <span>${escHtml(it.artigo)}${ql?' <i>('+escHtml(ql)+')</i>':''}${shopIsRemoved(it)?' ⚠️':''}</span>
        <span class="cmp-badge">${shopTipoIcon(it.tipo)}${shopIsMeal(it.tipo)&&it.dataValor?' '+fmtDiaMes(it.dataValor):' '+it.tipo}</span></label>`;
    });
    pl=`<details class="pick-det"${nOn?'':' open'}>
      <summary>🛒 Artigos da lista <span class="cmp-count" id="shop-pick-count">${nOn}/${pickItems.length}</span><span class="pick-chev">›</span></summary>
      ${rows}
      <div class="note" style="margin:6px 0 12px">Os artigos marcados saem da lista e ficam ligados a esta compra.</div>
    </details>`;
  }
  document.getElementById('shop-buy-body').innerHTML=(ro?'<div class="note" style="margin-bottom:10px">🔒 Só o administrador pode editar uma compra já registada.</div>':'')+
    `<div class="cmp-sort" style="margin-top:14px">
      <span class="sd-chip" id="shop-mode-det" onclick="compraSetMode(true)">💶 Preço por artigo</span>
      <span class="sd-chip" id="shop-mode-tot" onclick="compraSetMode(false)">∑ Só totais</span>
    </div>`+
    '<div id="shop-buy-lotes"></div>'+pl+
    '<div id="shop-buy-lines-sec"><div class="cmp-pick sf" style="margin-top:14px">Repartição do valor</div><div id="shop-buy-lines"></div>'+
    (ro?'':'<button class="btn ghost" id="shop-buy-addline" style="width:100%;margin-top:8px" onclick="compraAddLine()">＋ Outro gasto</button>')+'</div>';
  if(!isEdit)compraSeedLines();
  compraRenderLines();
  compraRefreshLotes();
  compraApplyMode();

  // Modo leitura (membro a ver uma compra já registada): desativa todos os campos
  const modal=document.getElementById('shop-buy-modal');
  ['shop-buy-who','shop-buy-date','shop-buy-desc'].forEach(id=>{const e=document.getElementById(id);if(e){e.disabled=ro;e.style.opacity=ro?'.7':'';}});
  if(ro){
    modal.querySelectorAll('#shop-buy-body input,#shop-buy-body select,#shop-buy-body button').forEach(el=>{el.disabled=true;el.style.opacity='.7';});
    modal.querySelectorAll('#shop-buy-body .sd-chip').forEach(el=>{el.style.pointerEvents='none';el.style.opacity='.6';});
  }

  document.getElementById('shop-buy-bg').classList.add('show');
  document.body.classList.add('no-scroll');
}
function closeShopBuyModal(){document.getElementById('shop-buy-bg').classList.remove('show');document.body.classList.remove('no-scroll');}
// Alterna "preço por artigo" ↔ "só totais": mostra/esconde as secções e refaz
// as linhas de detalhe (no modo por artigo entram também os artigos de tipo)
function compraSetMode(det){compraEdit.det=!!det;compraRefreshLotes();compraSeedLines();compraApplyMode();}
function compraPickChanged(){
  const c=document.getElementById('shop-pick-count');
  if(c){const all=[...document.querySelectorAll('.shop-pick')];c.textContent=all.filter(x=>x.checked).length+'/'+all.length;}
  compraRefreshLotes();compraSeedLines();
}
/* Linhas de repartição (compra NOVA): geradas dos artigos marcados no picker —
   TODOS eles, um grupo por refeição/tipo, artigos nas observações. Regenera a
   cada marca/desmarca, preservando os € já escritos (por grupo) e as linhas
   acrescentadas à mão com "＋ Outro gasto". */
function compraSeedLines(){
  if(compraEdit.id)return;   // edição: as linhas vêm das despesas gravadas
  const checked=[...document.querySelectorAll('.shop-pick:checked')].map(c=>+c.value);
  const its=shopArr().filter(x=>checked.includes(x._id));
  const gmap={};
  its.forEach(it=>{const k=shopGroupKey(it);(gmap[k]=gmap[k]||{tipo:it.tipo,dataValor:it.dataValor||null,items:[]}).items.push(it);});
  const ord={};SHOP_TIPOS.forEach((t,i)=>ord[t]=i);
  const prev=compraEdit.lines.filter(l=>l._auto);
  const manual=compraEdit.lines.filter(l=>!l._auto&&((l.valor!==''&&l.valor!=null)||(l.obs||'').trim()));
  compraEdit.lines=Object.values(gmap).sort((a,b)=>(ord[a.tipo]-ord[b.tipo])||((a.dataValor||'').localeCompare(b.dataValor||'')))
    .map(g=>{
      const ex=prev.find(l=>l.tipo===g.tipo&&(l.dataValor||'')===(g.dataValor||''));
      return {_auto:true,tipo:g.tipo,dataValor:g.dataValor,valor:ex?ex.valor:'',obs:g.items.map(i=>{const q=shopQtyLabel(i);return i.artigo+(q?' ('+q+')':'');}).join(', ')};
    }).concat(manual);
  if(!compraEdit.lines.length)compraEdit.lines.push({tipo:'Gerais',dataValor:null,valor:'',obs:''});
  compraRenderLines();
}
function compraApplyMode(){
  const det=!!compraEdit.det;
  const sec=document.getElementById('shop-buy-lines-sec');if(sec)sec.style.display=det?'none':'';
  const cd=document.getElementById('shop-mode-det'),ct=document.getElementById('shop-mode-tot');
  if(cd)cd.classList.toggle('on',det);
  if(ct)ct.classList.toggle('on',!det);
  compraUpdateTotal();
}
function shopBuyDescCount(){const inp=document.getElementById('shop-buy-desc');const c=document.getElementById('shop-buy-desc-count');if(inp&&c){c.textContent=`${inp.value.length}/30`;c.classList.toggle('full',inp.value.length>=30);}}

function compraRenderLines(){
  const cont=document.getElementById('shop-buy-lines');if(!cont)return;
  cont.innerHTML=compraEdit.lines.map((ln,i)=>{
    const mealSel=shopIsMeal(ln.tipo)?`<select class="cmp-ln-meal" onchange="compraLineField(${i},'dataValor',this.value)">${shopMealOptions(ln.tipo,ln.dataValor)}</select>`:'';
    return `<div class="cmp-ln">
      <div class="cmp-ln-row1">
        <select class="cmp-ln-tipo" onchange="compraLineTipo(${i},this.value)">${SHOP_TIPOS.map(t=>`<option value="${t}"${t===ln.tipo?' selected':''}>${t}</option>`).join('')}</select>
        <div class="cmp-ln-val"><span>€</span><input type="number" step="0.01" min="0" inputmode="decimal" placeholder="0,00" value="${ln.valor===''||ln.valor==null?'':ln.valor}" oninput="compraLineField(${i},'valor',this.value)"></div>
        <button class="cmp-ln-del" title="Remover linha" onclick="compraRemoveLine(${i})">✕</button>
      </div>
      ${mealSel?`<div class="cmp-ln-row2">${mealSel}</div>`:''}
      <input class="cmp-ln-obs" type="text" placeholder="Descrição / artigos (opcional)" value="${escHtml(ln.obs||'')}" oninput="compraLineField(${i},'obs',this.value)">
    </div>`;
  }).join('');
  compraUpdateTotal();
}
function compraLineField(i,field,value){if(!compraEdit.lines[i])return;compraEdit.lines[i][field]=field==='valor'?value:value;if(field==='valor')compraUpdateTotal();}
function compraLineTipo(i,tipo){if(!compraEdit.lines[i])return;compraEdit.lines[i].tipo=tipo;if(!shopIsMeal(tipo))compraEdit.lines[i].dataValor=null;compraRenderLines();}
function compraAddLine(){compraEdit.lines.push({tipo:'Gerais',dataValor:null,valor:'',obs:''});compraRenderLines();}
function compraRemoveLine(i){compraEdit.lines.splice(i,1);if(!compraEdit.lines.length)compraEdit.lines.push({tipo:'Gerais',dataValor:null,valor:'',obs:''});compraRenderLines();}
function compraUpdateTotal(){
  let tot=0;
  // Modo "preço por artigo" numa compra NOVA: as linhas de repartição estão
  // escondidas e não contam; na EDIÇÃO contam sempre (os tabuladores só mudam
  // a vista — as duas partes existem e são ambas gravadas)
  if(!compraEdit.det||compraEdit.id)compraEdit.lines.forEach(ln=>{const v=parseFloat(ln.valor);if(!isNaN(v))tot+=v;});
  if(compraEdit.det||compraEdit.id)(compraEdit.lotes||[]).forEach(l=>{const v=parseFloat(l.valor);if(!isNaN(v))tot+=v;});
  const el=document.getElementById('shop-buy-total');if(el)el.textContent=`Total: ${eur(rnd(tot,2))}`;
}

/* ── Detalhe por artigo no registo da compra (opt-in) ──
   TODOS os artigos de refeição marcados no picker podem ser detalhados com
   qtd + € — preencher o € torna o artigo um LOTE de stock, alocado por FIFO
   e reajustável depois (mesmo comprado a pensar numa só refeição: se sobrar,
   realoca-se). € vazio = artigo normal, coberto pelas linhas por refeição.
   "＋ Artigo detalhado" cria um lote avulso (comprado sem estar na lista). */
function compraDetectLotes(){
  const checked=[...document.querySelectorAll('.shop-pick:checked')].map(c=>+c.value);
  const its=shopArr().filter(x=>checked.includes(x._id)&&shopIsMeal(x.tipo)&&x.dataValor);
  const out=[];
  if(STOCK_TABLE){
    const g={};
    its.forEach(it=>{(g[shopArtKey(it.artigo)]=g[shopArtKey(it.artigo)]||{artigo:it.artigo,items:[]}).items.push(it);});
    out.push(...Object.values(g));
  }else if(compraEdit.det){
    // Sem tabela de stock: cada artigo×refeição vira despesa direta dessa refeição
    const g={};
    its.forEach(it=>{const k=it.tipo+'|'+it.dataValor+'|'+shopArtKey(it.artigo);(g[k]=g[k]||{artigo:it.artigo,tipoFix:it.tipo,dataFix:it.dataValor,items:[]}).items.push(it);});
    out.push(...Object.values(g));
  }
  // Modo "preço por artigo": os artigos de tipo (Gerais/Bebidas/…) também se
  // detalham — geram despesas diretas desse tipo, não lotes de stock.
  // Na edição entram sempre: os lotes gravados desses artigos têm de ter grupo,
  // senão desapareciam do modal ao alternar de separador.
  if(compraEdit.det||compraEdit.id){
    const nm=shopArr().filter(x=>checked.includes(x._id)&&!shopIsMeal(x.tipo));
    const g={};
    nm.forEach(it=>{const k=it.tipo+'|'+shopArtKey(it.artigo);(g[k]=g[k]||{artigo:it.artigo,tipoFix:it.tipo,items:[]}).items.push(it);});
    out.push(...Object.values(g));
  }
  return out;
}
function compraRefreshLotes(){
  const found=(STOCK_TABLE||compraEdit.det)?compraDetectLotes():[];
  const prev=compraEdit.lotes||[];
  const used=new Set();
  compraEdit.lotes=found.map(d=>{
    const keys=d.tipoFix?[]:[...new Set(d.items.map(i=>i.tipo+'|'+i.dataValor))].sort();
    // Match pelo nome da LISTA (_listArt quando a fatura renomeou o artigo);
    // um lote gravado (edição, _id) vale pelo nome, seja qual for a origem
    const ex=prev.find(l=>!used.has(l)&&!l.free&&shopSameArtigo(l._listArt||l.artigo,d.artigo)&&(l._id!=null||((l.tipoFix||'')===(d.tipoFix||'')&&(l.dataFix||'')===(d.dataFix||''))));
    if(ex){used.add(ex);return Object.assign(ex,{keys});}
    // qtd sugerida = soma das qtds pedidas (se numéricas e na mesma unidade)…
    let tot=0,u=null,ok=true;const pares={};
    d.items.forEach(i=>{const q=qtyParse(i.quantidade);if(!q){ok=false;return;}if(u==null)u=q.u;if(q.u!==u)ok=false;else{tot=rnd(tot+q.n,3);if(shopIsMeal(i.tipo)&&i.dataValor){const k=i.tipo+'|'+i.dataValor;pares[k]=rnd((pares[k]||0)+q.n,3);}}});
    // …menos o stock JÁ alocado a cada refeição (compra nova): sugere-se
    // comprar só o que falta, não o pedido inteiro. Quem comprar mais, edita —
    // o excedente fica por alocar (bolsa comum).
    if(ok&&u!=null&&STOCK_TABLE&&!compraEdit.id){
      let falta=0,emPar=0;
      for(const k in pares){
        const[tp,dt]=k.split('|');emPar=rnd(emPar+pares[k],3);
        falta=rnd(falta+Math.max(0,rnd(pares[k]-mealStockAllocFor(d.artigo,u,tp,dt),3)),3);
      }
      tot=rnd(falta+Math.max(0,rnd(tot-emPar,3)),3);   // pedidos sem refeição ficam por inteiro
    }
    let qtd=ok&&tot>0?fmtQty(tot,u):'';
    if(!qtd&&d.tipoFix&&d.items.length===1)qtd=shopQtyLabel(d.items[0]);
    // Destino: itens de tipo (Bebidas/Gerais/…) → esse tipo; refeição fixa (sem
    // tabela) → 'Ref|data'; itens de refeição → proposta concreta (FIFO) já feita.
    const destino=d.tipoFix?(d.dataFix?d.tipoFix+'|'+d.dataFix:d.tipoFix):'';
    const lote={artigo:d.artigo,qtd,valor:'',keys,tipoFix:d.tipoFix||null,dataFix:d.dataFix||null,destino,splits:null};
    if(!d.tipoFix)compraProporDestino(lote);   // propõe alocação concreta às refeições
    return lote;
  }).concat(prev.filter(l=>!used.has(l)&&l.free));   // artigos fora da lista mantêm-se
  compraRenderLotes();
}
/* Opções de destino de um item detalhado: "por alocar" (FIFO), tipos puros
   (Gerais/Bebidas/Cerveja) e cada refeição. Chave: '' | 'Tipo' | 'Ref|data'. */
/* ── Seletor de destino (bottom-sheet próprio, no tema da app) ──
   Substitui o <select> nativo. A lista tem só destinos concretos — tipos de
   despesa e refeições. A distribuição automática (FIFO) é PROPOSTA pela app
   (compraProporDestino), nunca uma opção que o utilizador escolhe. */
// Dia da semana sem o "-feira" (Sexta, Sábado, Domingo) — para rótulos curtos
function diaCurto(ds){const s=diaExtenso(ds);return s?s.replace(/-feira$/i,''):'';}
function destPickList(){
  const out=[];
  ['Gerais','Bebidas','Cerveja'].forEach(t=>out.push({value:t,icon:shopTipoIcon(t),label:t,group:'Tipo'}));
  // Rótulo com o dia da semana (mais útil que o prato); o prato fica como
  // sublinha no bottom-sheet (sub) — no botão só aparece o rótulo curto
  (DATA.refeicoesDef||[]).filter(r=>shopIsMeal(r.ref)).forEach(r=>out.push({value:r.ref+'|'+r.data,icon:shopTipoIcon(r.ref),label:`${r.ref} ${diaCurto(r.data)}, ${fmtDiaMes(r.data)}`,sub:r.prato||'',group:'Refeição'}));
  return out;
}
// Rótulo (ícone + texto) de um valor de destino, para o botão do seletor
function destLabel(value){
  const it=value?destPickList().find(x=>x.value===value):null;
  if(it)return{icon:it.icon,label:it.label};
  const a=value?destinoAloc(value,0):null;
  if(a)return{icon:shopTipoIcon(a.tipo),label:alocIsMeal(a)?`${a.tipo} ${diaCurto(a.data)}, ${fmtDiaMes(a.data)}`:a.tipo};
  return{icon:'🧺',label:'Escolher destino'};
}
// Botão que abre o seletor (parece um campo, mas é bonito e controlável)
function destBtnHtml(value,onclick,dis){
  const d=destLabel(value);
  return `<button type="button" class="dest-btn${dis?' dis':''}" ${dis?'disabled':`onclick="${onclick}"`}>
    <span class="dest-ic">${d.icon}</span><span class="dest-lbl">${escHtml(d.label)}</span>${dis?'':'<span class="dest-chev">▾</span>'}</button>`;
}
let _dpick=null;   // {items, cb}
function openDestPicker(current,cb,title){
  const items=destPickList();
  _dpick={items,cb};
  document.getElementById('dpick-title').textContent=title||'Alocar a…';
  let last=null,h='';
  items.forEach((it,idx)=>{
    if(it.group!==last){h+=`<div class="dsheet-grp">${it.group==='Tipo'?'Tipos de despesa':'Refeições'}</div>`;last=it.group;}
    h+=`<button type="button" class="dsheet-opt${it.value===current?' on':''}" onclick="pickDest(${idx})">
      <span class="dsheet-ic">${it.icon}</span><span class="dsheet-lbl">${escHtml(it.label)}${it.sub?`<small class="dsheet-sub">${escHtml(it.sub)}</small>`:''}</span>${it.value===current?'<span class="dsheet-chk">✓</span>':''}</button>`;
  });
  document.getElementById('dpick-list').innerHTML=h;
  document.getElementById('dpick-bg').classList.add('show');
}
function pickDest(idx){const d=_dpick;closeDestPicker();if(d&&d.cb)d.cb(d.items[idx].value);}
function closeDestPicker(e){if(e&&e.target&&e.target.id!=='dpick-bg')return;document.getElementById('dpick-bg').classList.remove('show');_dpick=null;}
/* Propõe uma alocação CONCRETA para um lote de refeição (FIFO nos bastidores):
   um destino que cobre a compra toda → destino simples; vários destinos, OU um
   destino que não cobre tudo (a sobra fica por alocar) → split; sem procura →
   refeição pedida (se só uma) ou Gerais. Só para lotes de refeição. */
function compraProporDestino(l){
  // A procura casa-se pelo nome da LISTA (se a fatura renomeou o artigo, o
  // pedido continua a chamar-se como na lista); um lote já gravado não se
  // bloqueia a si próprio (skipLotId)
  const q=qtyParse(l.qtd);
  if(q&&q.n>0){
    const al=fifoAlocar(l._listArt||l.artigo,q.n,q.u,l._id!=null?l._id:null,(l.keys&&l.keys.length)?l.keys:null);
    const totAl=rnd(al.reduce((s,a)=>s+a.qtd,0),3);
    // Vários destinos, ou um só que não chega para toda a compra → split, para
    // a sobra ficar mesmo por alocar (a bolsa comum) e não inflar um destino.
    if(al.length>=2||(al.length===1&&totAl<q.n-0.0005)){
      l.splits=al.map(a=>({destino:alocToDestino(a),qtd:a.qtd}));l.destino='';return;
    }
    if(al.length===1){l.destino=alocToDestino(al[0]);l.splits=null;return;}
  }
  l.splits=null;
  if(l.keys&&l.keys.length===1)l.destino=l.keys[0];
  else if(!l.destino)l.destino='Gerais';
}
// Nota do split: quanto falta/sobra repartir face à qtd do lote
function compraSplitNote(l){
  const q=qtyParse(l.qtd);const u=q?q.u:'';
  const tot=(l.splits||[]).reduce((a,s)=>a+(parseFloat(String(s.qtd).replace(',','.'))||0),0);
  if(!q)return 'Reparte a quantidade pelos destinos (o resto fica por alocar).';
  const livre=rnd(q.n-tot,3);
  if(livre>0.0005)return `Falta repartir ${fmtQty(livre,u)} → fica na bolsa comum.`;
  if(livre<-0.0005)return `⚠️ Repartiste ${fmtQty(rnd(tot,3),u)} — mais do que ${fmtQty(q.n,u)}.`;
  return 'Repartido a 100%.';
}
function compraLoteHtml(l,i){
  // Estado do matching com a fatura (só nos artigos do carrinho)
  const tag=l._fat==='ok'?`<span class="lote-tag ok">✓ na fatura</span>`
    :l._fat==='miss'?`<span class="lote-tag miss">⚠ não encontrado</span>`
    :l._fat==='warn'?`<span class="lote-tag warn">⚠ qtd difere</span>`:'';
  // Se a fatura renomeou o artigo, o nome pedido na lista fica como nota
  const sub=(!l.free&&l._listArt&&!shopSameArtigo(l._listArt,l.artigo))?`<small class="lote-list-art">na lista: ${escHtml(l._listArt)}</small>`:'';
  const name=l.free
    ?`<input class="lote-name-in" type="text" maxlength="60" placeholder="Nome do artigo" value="${escHtml(l.artigo||'')}" oninput="compraEdit.lotes[${i}].artigo=this.value">`
    :`<span class="lote-name">${l.tipoFix?shopTipoIcon(l.tipoFix)+' ':''}${escHtml(l.artigo)}${sub}</span>`;
  const head=`<div class="lote-head">${name}${tag}${l.free?`<button class="lote-x" title="Remover" onclick="compraDelLote(${i})">✕</button>`:''}</div>`;
  // Uma só linha: qtd + preço + destino (o destino desce para o bloco de split
  // quando o artigo está dividido por vários destinos)
  const hasSplit=!!(l.splits&&l.splits.length);
  const destInline=(STOCK_TABLE&&!hasSplit)
    ?destBtnHtml(l.destino,`compraDestPick(${i})`)+`<button class="lote-split-btn" title="Dividir por vários destinos" onclick="compraLoteAddSplit(${i})">⇄</button>`
    :'';
  const fields=`<div class="lote-row">
      <input class="lote-qty" type="text" placeholder="Qtd" title="Quantidade" value="${escHtml(l.qtd||'')}" oninput="compraEdit.lotes[${i}].qtd=this.value" onblur="this.value=normalizeQty(this.value);compraEdit.lotes[${i}].qtd=this.value;compraSplitNoteUpd(${i})">
      <div class="price-in lote-price"><input type="number" step="0.01" min="0" inputmode="decimal" placeholder="0,00" title="Preço" value="${l.valor===''||l.valor==null?'':l.valor}" oninput="compraEdit.lotes[${i}].valor=this.value;compraUpdateTotal()"><i>€</i></div>
      ${destInline}
    </div>`;
  let destBlock='';
  if(STOCK_TABLE&&hasSplit){
    const rows=l.splits.map((s,j)=>`<div class="split-row">
        ${destBtnHtml(s.destino,`compraSplitDestPick(${i},${j})`)}
        <input class="split-qty" type="text" inputmode="decimal" placeholder="qtd" value="${escHtml(s.qtd==null?'':String(s.qtd))}" oninput="compraLoteSplitQty(${i},${j},this.value)">
        <button class="lote-x" title="Remover destino" onclick="compraLoteDelSplit(${i},${j})">✕</button>
      </div>`).join('');
    destBlock=`<div class="lote-splits">${rows}
      <button class="cmp-mini split-add" onclick="compraLoteAddSplit(${i})">＋ destino</button>
      <div class="split-note" id="split-note-${i}">${compraSplitNote(l)}</div></div>`;
  }
  const fat=(!l.free&&l._sug?`<label class="lote-sug"><input type="checkbox" onchange="faturaSugToggle(${i})">
        <div class="sug-txt"><b>Corresponde a esta linha da fatura?</b><span>${escHtml(l._sug.artigo)}${l._sug.qtd?' · '+escHtml(l._sug.qtd):''}</span></div>
        <span class="sug-price">${eur(l._sug.valor)}</span></label>`:'')+
    (!l.free&&l._subs?l._subs.map((s,j)=>`<label class="lote-sug alt"><input type="checkbox" onchange="faturaSubToggle(${i},${j})">
        <div class="sug-txt"><b>＋ Outra marca do mesmo?</b><span>${escHtml(s.artigo)}${s.qtd?' · '+escHtml(s.qtd):''}</span></div>
        <span class="sug-price">${eur(s.valor)}</span></label>`).join(''):'');
  // Pediste X no carrinho mas o talão traz Y → o talão manda no stock
  const qtyHint=(!l.free&&l._fat==='warn'&&l._qtdPedida)
    ?`<div class="lote-hint">📝 Pediste <b>${escHtml(String(l._qtdPedida))}</b> no carrinho; o talão tem <b>${escHtml(l.qtd||'—')}</b> — é esta que entra em stock.</div>`:'';
  const cls='lote-card'+(l._fat==='miss'?' is-miss':l._fat==='warn'?' is-warn':l._fat==='ok'?' is-ok':'');
  return `<div class="${cls}">${head}${fields}${qtyHint}${destBlock}${fat}</div>`;
}
function compraRenderLotes(){
  const cont=document.getElementById('shop-buy-lotes');if(!cont)return;
  const ls=compraEdit.lotes||[];
  const det=!!compraEdit.det;
  // Tabulador "Só totais": o detalhe por artigo fica escondido (na edição os
  // lotes mantêm-se em memória e continuam a ser gravados — é só a vista)
  if(!det){cont.innerHTML='';compraUpdateTotal();return;}
  // Aviso: artigos do carrinho que a fatura não detetou (ficam por tratar se o
  // preço ficar em branco). Fica visível na revisão, antes de registar.
  const miss=ls.filter(l=>!l.free&&l._fat==='miss');
  const missWarn=miss.length?`<div class="lote-miss-warn">⚠️ <b>${miss.length} artigo(s) do carrinho não apareceram na fatura.</b> Se deixares o preço em branco, ficam na lista <b>por tratar</b> (não são dados como comprados):<ul>${miss.map(l=>'<li>'+escHtml(l.artigo)+(l.qtd?' <i style="color:var(--muted);font-style:normal">('+escHtml(l.qtd)+')</i>':'')+'</li>').join('')}</ul></div>`:'';
  cont.innerHTML=`<div class="cmp-pick sf" style="margin-top:14px">💶 Preço por artigo</div>`+
    ls.map((l,i)=>compraLoteHtml(l,i)).join('')+
    missWarn+
    `<button class="btn ghost" style="width:100%;margin-top:8px" onclick="compraAddLote()">＋ Artigo fora da lista</button>`+
    '<div class="note">A app propõe o destino de cada artigo (refeição ou tipo) — confirma ou muda. Podes dividir um artigo por vários destinos com ⇄. Reajustas tudo depois no separador 🧺 Stock.</div>'+
    faturaExtrasHtml();
  compraUpdateTotal();
}
function compraSplitNoteUpd(i){const l=(compraEdit.lotes||[])[i];const el=document.getElementById('split-note-'+i);if(l&&el)el.innerHTML=compraSplitNote(l);}
function compraLoteSplitQty(i,j,v){const l=(compraEdit.lotes||[])[i];if(!l||!l.splits||!l.splits[j])return;l.splits[j].qtd=v;compraSplitNoteUpd(i);}
function compraLoteAddSplit(i){
  const l=(compraEdit.lotes||[])[i];if(!l)return;
  if(!l.splits||!l.splits.length){
    const q=qtyParse(l.qtd);
    l.splits=[{destino:(l.destino||''),qtd:q?q.n:''},{destino:'',qtd:''}];
  }else l.splits.push({destino:'',qtd:''});
  compraRenderLotes();
}
function compraLoteDelSplit(i,j){
  const l=(compraEdit.lotes||[])[i];if(!l||!l.splits)return;
  l.splits.splice(j,1);
  if(l.splits.length<=1){l.destino=l.splits.length?(l.splits[0].destino||''):(l.destino||'');l.splits=null;}
  compraRenderLotes();
}
function compraDestPick(i){const l=(compraEdit.lotes||[])[i];if(!l)return;openDestPicker(l.destino,v=>{l.destino=v;l.splits=null;compraRenderLotes();},'Alocar '+(l.artigo||'artigo'));}
function compraSplitDestPick(i,j){const l=(compraEdit.lotes||[])[i];if(!l||!l.splits||!l.splits[j])return;openDestPicker(l.splits[j].destino,v=>{l.splits[j].destino=v;compraRenderLotes();},'Destino');}
function compraAddLote(){
  compraEdit.lotes=compraEdit.lotes||[];
  compraEdit.lotes.push({free:true,artigo:'',qtd:'',valor:'',destino:'Gerais',keys:[]});
  compraRenderLotes();
}
function compraDelLote(i){const l=compraEdit.lotes[i];if(!l||!l.free)return;compraEdit.lotes.splice(i,1);compraRenderLotes();}

/* ═══ IMPORTAR FATURA (foto → Gemini via Edge Function fatura-ocr) ═══
   Só em compras NOVAS: tira-se/escolhe-se a foto do talão, a Edge Function
   devolve {loja, data, total, linhas:[{artigo,qtd,preco}]} e a app pré-preenche
   o modo "preço por artigo" — matching difuso com os artigos marcados; linhas
   sem correspondência entram como artigos fora da lista. O utilizador revê
   sempre antes de registar. */
/* Despesa de cash-flow → itemização/fatura: uma despesa com fatura é, por baixo,
   uma compra sem artigos de lista (mesmo compra_id, entra em Comprados + Stock e
   fica movível). Herda quem/data/descritivo do cash-flow e abre logo o seletor. */
function cfAbrirCompraFatura(){
  const who=(document.getElementById('cf-who')||{}).value||'';
  const date=(document.getElementById('cf-date')||{}).value||'';
  const desc=((document.getElementById('cf-desc')||{}).value||'').trim();
  closePayModal();
  openCompra(null);
  const w=document.getElementById('shop-buy-who');
  if(who&&w&&[...w.options].some(o=>o.value===who))w.value=who;
  const d=document.getElementById('shop-buy-date');if(date&&d)d.value=date;
  const e=document.getElementById('shop-buy-desc');if(desc&&e){e.value=desc.slice(0,30);shopBuyDescCount();}
  compraSetMode(true);   // itemização = modo "preço por artigo"
  faturaPick();
}
function faturaPick(){const i=document.getElementById('fatura-file');if(i)i.click();}
async function faturaChosen(inp){
  const f=inp.files&&inp.files[0];inp.value='';
  if(!f)return;
  const btn=document.getElementById('shop-buy-ocr-btn');
  const label=btn.innerHTML;   // duas linhas (título + subtítulo) → repor em HTML
  btn.disabled=true;btn.textContent='⏳ A ler a fatura…';
  try{
    // PDF vai tal e qual (o Gemini lê PDFs nativamente); imagem é comprimida em canvas
    const isPdf=f.type==='application/pdf'||/\.pdf$/i.test(f.name||'');
    if(isPdf&&f.size>4*1024*1024)throw new Error('PDF demasiado grande (máx. 4 MB)');
    const {b64,mime}=isPdf?await faturaLerPdf(f):await faturaComprime(f);
    // Com a migração das categorias corrida, a lista (nome+descritivo) segue
    // no pedido — o Gemini devolve também a categoria de cada linha
    const body={image:b64,mime};
    if(CATS_TABLE&&CATEGORIAS.length)body.categorias=catPromptList();
    const r=await sbFetch(`${SB_URL}/functions/v1/fatura-ocr`,{
      method:'POST',
      headers:{'Content-Type':'application/json','apikey':SB_KEY},
      body:JSON.stringify(body)
    });
    if(!r.ok){const e=await r.json().catch(()=>({}));throw new Error(e.error||('HTTP '+r.status));}
    faturaAplicar(await r.json());
  }catch(e){
    // "Load failed"/"Failed to fetch" é o erro genérico do browser quando o
    // pedido é cortado por timeout (~60s no iOS) ou a ligação cai a meio.
    const m=String(e&&e.message||e);
    const rede=/load failed|failed to fetch|networkerror|timed? ?out/i.test(m);
    toast(rede
      ?'A leitura demorou demasiado ou falhou a ligação. Tenta uma foto mais nítida, um PDF mais pequeno, ou volta a tentar.'
      :'Não consegui ler a fatura: '+m,'bad');
  }finally{
    btn.disabled=false;btn.innerHTML=label;
  }
}
// Lê um PDF em base64, sem transformação (o modelo aceita PDFs diretamente)
function faturaLerPdf(file){
  return new Promise((resolve,reject)=>{
    const rd=new FileReader();
    rd.onload=()=>resolve({b64:String(rd.result).split(',')[1],mime:'application/pdf'});
    rd.onerror=()=>reject(new Error('não consegui ler o PDF'));
    rd.readAsDataURL(file);
  });
}
// Reduz a foto (máx 1600px no lado maior, JPEG q0.85): chega de sobra para o
// modelo ler o talão e mantém o upload leve mesmo em rede móvel
function faturaComprime(file){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      const MAX=1600;
      const s=Math.min(1,MAX/Math.max(img.naturalWidth,img.naturalHeight));
      const w=Math.round(img.naturalWidth*s),h=Math.round(img.naturalHeight*s);
      const cv=document.createElement('canvas');cv.width=w;cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      URL.revokeObjectURL(img.src);
      const dataUrl=cv.toDataURL('image/jpeg',0.85);
      resolve({b64:dataUrl.split(',')[1],mime:'image/jpeg'});
    };
    img.onerror=()=>{URL.revokeObjectURL(img.src);reject(new Error('imagem inválida'));};
    img.src=URL.createObjectURL(file);
  });
}
// Tokens do nome do artigo (sem acentos, minúsculas, mín. 3 letras)
function faturaTokens(s){return shopArtKey(s).replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(t=>t.length>=3);}
// Score 0..1 — fração dos tokens do artigo da lista presentes na linha do talão
// (match por prefixo nos dois sentidos: "batata" encontra "batatas" e vice-versa)
function faturaScore(artLista,artTalao){
  const a=faturaTokens(artLista),b=faturaTokens(artTalao);
  if(!a.length||!b.length)return 0;
  let hit=0;
  a.forEach(t=>{if(b.some(x=>x.startsWith(t)||t.startsWith(x)))hit++;});
  return hit/a.length;
}
function faturaAplicar(d){
  if(!d||!Array.isArray(d.linhas)||!d.linhas.length){toast('Não encontrei artigos legíveis na fatura','bad');return;}
  // O pré-preenchimento é por artigo → garante o modo "preço por artigo"
  if(!compraEdit.det)compraSetMode(true);
  // Cabeçalho: só preenche o que está vazio (não pisa o que o utilizador escreveu)
  const desc=document.getElementById('shop-buy-desc');
  if(desc&&!desc.value.trim()&&d.loja){desc.value=String(d.loja).slice(0,30);shopBuyDescCount();}
  const date=document.getElementById('shop-buy-date');
  if(date&&typeof d.data==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d.data))date.value=d.data;
  // Matching por níveis de confiança:
  //   score 1.0 (todas as palavras do artigo na linha) → preenche por defeito ✓
  //   0.5–1.0 → SUGESTÃO com checkbox desmarcada (o utilizador confirma)
  //   2.ª linha a 1.0 no MESMO artigo (várias marcas, ex. Lays+Ruffles)
  //     → sub-artigo por confirmar, que herda o destino do genérico
  const linhas=d.linhas.filter(l=>l&&l.artigo&&typeof l.preco==='number'&&l.preco>=0)
    .map(ln=>({artigo:String(ln.artigo).slice(0,60),qtd:ln.qtd?normalizeQty(String(ln.qtd)):'',valor:rnd(ln.preco,2),categoria:ln.categoria?String(ln.categoria).slice(0,40):null}));
  // Categorias sugeridas pela AI: gravam-se já (só onde não havia — a memória
  // artigo→categoria é global e vale mesmo que a compra não chegue a registar-se)
  catAIMappings(linhas.filter(l=>l.categoria)).then(n=>{if(n&&TAB==='stock')renderStock();});
  const lotes=compraEdit.lotes||[];
  // Reset (re-importação): volta ao nome da lista para refazer o matching do zero
  lotes.forEach(l=>{delete l._fat;delete l._sug;delete l._subs;delete l._impQtds;delete l._qtdPedida;if(l._listArt){l.artigo=l._listArt;delete l._listArt;}});
  const pares=[];
  lotes.forEach((l,i)=>{if(l.free)return;l._qtdPedida=l.qtd||'';linhas.forEach((ln,j)=>{const s=faturaScore(l.artigo,ln.artigo);if(s>=0.5)pares.push({i,j,s});});});
  pares.sort((a,b)=>b.s-a.s);
  const loteUsado=new Set(),linhaUsada=new Set();
  let preenchidos=0,sugestoes=0;
  pares.forEach(p=>{
    if(loteUsado.has(p.i)||linhaUsada.has(p.j))return;
    const l=lotes[p.i],ln=linhas[p.j];
    if(p.s===1){                              // certeza → entra por defeito
      loteUsado.add(p.i);linhaUsada.add(p.j);
      if(l.valor===''||l.valor==null)l.valor=ln.valor;
      // O talão manda na quantidade real (o pedido do carrinho é só guia): se a
      // fatura traz qtd, é essa que entra em stock — não o que se pediu.
      if(ln.qtd)l.qtd=ln.qtd;
      // …e manda também no NOME do artigo (a lista é só guia); o nome pedido
      // fica em _listArt para o match com a procura da lista e como nota na UI
      if(ln.artigo&&!shopSameArtigo(l.artigo,ln.artigo)){l._listArt=l.artigo;l.artigo=ln.artigo;}
      l._fat='ok';l._impQtds=[ln.qtd];
      faturaQtdRecheck(l);
      if(!l.tipoFix)compraProporDestino(l);   // re-propõe com a qtd real do talão
      preenchidos++;
    }else{                                    // parcial → só com o teu OK
      loteUsado.add(p.i);linhaUsada.add(p.j);
      l._sug=ln;
      sugestoes++;
    }
  });
  // 2.ª passagem: linhas restantes que batem a 100% num artigo JÁ preenchido
  // (genérico → várias marcas) ficam como sub-artigos por confirmar
  let subs=0;
  linhas.forEach((ln,j)=>{
    if(linhaUsada.has(j))return;
    lotes.forEach((l,i)=>{
      if(linhaUsada.has(j)||l.free||l._fat!=='ok')return;
      if(faturaScore(l._listArt||l.artigo,ln.artigo)===1){linhaUsada.add(j);(l._subs=l._subs||[]).push(ln);subs++;}
    });
  });
  // Artigos do carrinho SEM correspondência na fatura → alerta ⚠️ (fica € vazio)
  let semMatch=0;
  lotes.forEach((l,i)=>{if(!l.free&&!loteUsado.has(i)){l._fat='miss';semMatch++;}});
  // Linhas da fatura sem correspondência → EXTRAS, desmarcados por defeito
  compraEdit.faturaExtras=linhas.filter((ln,j)=>!linhaUsada.has(j));
  const extras=compraEdit.faturaExtras.length;
  compraEdit.lotes=lotes;
  compraRenderLotes();
  const porConfirmar=sugestoes+subs+extras;
  toast(`Fatura lida: ${preenchidos} preenchido(s) ✓${porConfirmar?`, ${porConfirmar} por confirmar ☐`:''}${semMatch?`, ${semMatch} sem correspondência ⚠️`:''}`,'ok');
}
// Aviso "quantidades não batem": compara o pedido da lista com a soma do que
// veio da fatura para esse artigo (só quando ambos são numéricos, mesma unidade)
function faturaQtdRecheck(l){
  if(l._fat!=='ok'&&l._fat!=='warn')return;
  const ped=qtyParse(l._qtdPedida||'');
  if(!ped||!(l._impQtds||[]).length)return;
  let tot=0;
  for(const q of l._impQtds){const p=qtyParse(q||'');if(!p||p.u!==ped.u)return;tot=rnd(tot+p.n,3);}
  l._fat=Math.abs(tot-ped.n)<0.001?'ok':'warn';
}
// Confirmar a sugestão de match parcial: aplica € e qtd ao artigo
function faturaSugToggle(i){
  const l=(compraEdit.lotes||[])[i];if(!l||!l._sug)return;
  const ln=l._sug;delete l._sug;
  if(l.valor===''||l.valor==null)l.valor=ln.valor;
  if(ln.qtd)l.qtd=ln.qtd;   // qtd real do talão (o pedido do carrinho é só guia)
  // O nome do talão também manda (a lista fica como nota em _listArt)
  if(ln.artigo&&!shopSameArtigo(l.artigo,ln.artigo)){l._listArt=l._listArt||l.artigo;l.artigo=ln.artigo;}
  l._fat='ok';l._impQtds=[ln.qtd];
  faturaQtdRecheck(l);
  if(!l.tipoFix)compraProporDestino(l);
  compraRenderLotes();
}
// Confirmar um sub-artigo (outra marca do mesmo genérico): vira artigo fora da
// lista com o destino herdado — refeição única → essa; pedido p/ várias
// refeições → 🧺 Stock por alocar (alocação manual); tipo (Gerais/…) → o tipo
function faturaSubToggle(i,j){
  const l=(compraEdit.lotes||[])[i];if(!l||!l._subs||!l._subs[j])return;
  const ln=l._subs.splice(j,1)[0];
  if(!l._subs.length)delete l._subs;
  const multi=(l.keys||[]).length>1;
  const destino=l.tipoFix?l.tipoFix:((l.keys||[]).length===1?l.keys[0]:(STOCK_TABLE?'':'Gerais'));
  (compraEdit.lotes=compraEdit.lotes||[]).push({free:true,artigo:ln.artigo,qtd:ln.qtd,valor:ln.valor,destino,keys:[],_fat:'ok'});
  (l._impQtds=l._impQtds||[]).push(ln.qtd);
  faturaQtdRecheck(l);
  compraRenderLotes();
  if(multi&&STOCK_TABLE)toast('Fica em 🧺 Stock por alocar — depois de registares, aloca às refeições no separador Stock','ok');
}
/* Extras da fatura (linhas que não estavam no carrinho): checkbox desmarcada
   por defeito; marcar converte em "artigo fora da lista" editável (o ✕ do
   lote serve de desfazer). Os que ficarem desmarcados não entram no registo. */
function faturaExtrasHtml(){
  const ex=compraEdit.faturaExtras||[];
  if(!ex.length)return '';
  return `<div class="cmp-pick sf" style="margin-top:14px">🧾 Extras da fatura — não estavam na lista</div>`+
    ex.map((e,i)=>`<label class="cmp-pick-row"><input type="checkbox" onchange="faturaExtraToggle(${i})">
      <span>${escHtml(e.artigo)}${e.qtd?' <i>('+escHtml(e.qtd)+')</i>':''}</span>
      <span class="cmp-badge">${eur(e.valor)}</span></label>`).join('')+
    '<div class="note" style="margin-top:6px">Estão na fatura mas não estavam no carrinho. Marca os que são das Festas; os restantes ficam de fora.</div>';
}
function faturaExtraToggle(i){
  const e=(compraEdit.faturaExtras||[])[i];if(!e)return;
  compraEdit.faturaExtras.splice(i,1);
  (compraEdit.lotes=compraEdit.lotes||[]).push({free:true,artigo:e.artigo,qtd:e.qtd,valor:e.valor,destino:'Gerais',keys:[]});
  compraRenderLotes();
}

async function saveCompra(){
  if(!DATA._sbId){toast('Sem ligação — recarrega a página','bad');return;}
  if(contasFechadas()){toast('Contas fechadas','bad');return;}
  const isEdit=!!compraEdit.id;
  const who=document.getElementById('shop-buy-who').value;
  const date=document.getElementById('shop-buy-date').value;
  const desc=(document.getElementById('shop-buy-desc').value||'').trim().slice(0,30);
  if(!who){toast('Quem pagou?','bad');return;}
  if(!date){toast('Indica a data','bad');return;}
  if(!isAdmin()&&!MY_NAMES.includes(who)){toast('Só podes registar compras tuas ou do cônjuge','bad');return;}
  // Detalhe por artigo: lotes de stock (qtd+€, alocados por FIFO) e despesas
  // diretas por tipo/refeição (tipoFix e artigos fora da lista com destino tipo)
  const det=!!compraEdit.det;
  const lotes=[];const tipoRows={};const naoDetetados=[];   // tipoRows: 'Tipo'|'Tipo|data' → artigos; naoDetetados: artigos do carrinho sem preço
  // "Só totais" numa compra nova: o detalhe está escondido → não entra no registo
  for(const l of ((det||isEdit)?(compraEdit.lotes||[]):[])){
    const artigo=(l.artigo||'').trim();
    const v=rnd(parseFloat(l.valor),2);
    if(!v||v<=0){
      // Artigo do carrinho sem preço (ex.: não veio na fatura) → NÃO é comprado:
      // fica na lista por tratar e avisa-se abaixo. Avulso em branco é ignorado.
      // Só em compras NOVAS: na edição um € vazio não solta artigos (podem
      // estar cobertos pelas linhas de repartição).
      if(det&&!isEdit&&artigo&&!l.free)naoDetetados.push({artigo,qtd:l.qtd||''});
      continue;
    }
    if(!artigo){toast('Indica o nome do artigo detalhado','bad');return;}
    if(STOCK_TABLE){
      // Unificado: TODO item detalhado vira um lote movível. O destino/split
      // guia a alocação (refeição, tipo puro, ou FIFO se ficar "por alocar").
      // Sem quantidade legível assume-se 1 unidade (o € cobre o lote inteiro).
      let q=qtyParse(l.qtd);if(!q||!(q.n>0))q={n:1,u:''};
      const splits=(l.splits&&l.splits.length)?l.splits.filter(s=>s.destino&&(parseFloat(String(s.qtd).replace(',','.'))>0)):null;
      lotes.push({artigo,qtd:q.n,unidade:q.u,valor:v,destino:(l.destino!=null?l.destino:''),splits:(splits&&splits.length?splits:null),keys:l.free?[]:(l.keys||[])});
      continue;
    }
    // Sem tabela de stock: item detalhado → despesa direta do tipo/refeição
    const tipoDest=l.tipoFix||((l.free&&l.destino&&!String(l.destino).includes('|'))?l.destino:null);
    if(tipoDest){
      const k=l.dataFix?`${tipoDest}|${l.dataFix}`:tipoDest;
      (tipoRows[k]=tipoRows[k]||[]).push({artigo,qtd:(l.qtd||'').trim(),valor:v});
      continue;
    }
    const q=qtyParse(l.qtd);
    if(!q||!(q.n>0)){toast(`Indica a quantidade de "${artigo}" (ex: 10 pacotes)`,'bad');return;}
    lotes.push({artigo,qtd:q.n,unidade:q.u,valor:v,keys:l.free?(l.destino?[l.destino]:[]):(l.keys||[])});
  }
  const rows=[];
  // Modo por totais: validar linhas (totalmente vazias são ignoradas se houver
  // mais alguma coisa). Na edição as linhas entram SEMPRE — o tabulador ativo
  // só muda a vista, não o que se grava.
  if(!det||isEdit)for(const ln of compraEdit.lines){
    const v=rnd(parseFloat(ln.valor),2);
    const vazia=(!v||v<=0)&&!(ln.obs||'').trim();
    if(vazia&&(lotes.length||Object.keys(tipoRows).length||compraEdit.lines.length>1))continue;
    if(!v||v<=0){toast(`Preenche o valor de "${shopGroupLabel(ln.tipo,ln.dataValor)}"`,'bad');return;}
    if(shopIsMeal(ln.tipo)&&!ln.dataValor){toast(`Escolhe a refeição em "${ln.tipo}"`,'bad');return;}
    rows.push({tipo:ln.tipo,data_valor:shopIsMeal(ln.tipo)?ln.dataValor:null,valor:v,obs:(ln.obs||'').trim()});
  }
  // Despesas diretas geradas do detalhe: uma linha por tipo (ou tipo+refeição)
  for(const k in tipoRows){
    const p=k.split('|');const its=tipoRows[k];
    rows.push({tipo:p[0],data_valor:p[1]||null,valor:rnd(its.reduce((a,x)=>a+x.valor,0),2),obs:its.map(x=>x.artigo+(x.qtd?' ('+x.qtd+')':'')).join(', ')});
  }
  // O valor dos lotes entra numa linha "🧺 Stock" (Gerais → bolsa comum); o
  // calcular() move depois o alocado para as refeições via stock_lotes
  if(lotes.length)rows.push({tipo:'Gerais',data_valor:null,valor:rnd(lotes.reduce((a,l)=>a+l.valor,0),2),obs:STOCK_OBS});
  if(!rows.length){toast(det?'Preenche o € dos artigos (ou marca artigos da lista)':'Adiciona pelo menos uma linha','bad');return;}
  const checkedIds=[...document.querySelectorAll('.shop-pick:checked')].map(c=>+c.value);
  // Artigos marcados no carrinho mas não detetados na fatura (sem preço): ficam
  // por tratar (não comprados). Avisa e confirma antes de registar.
  const missIds=new Set(shopArr().filter(x=>checkedIds.includes(x._id)&&naoDetetados.some(n=>shopSameArtigo(n.artigo,x.artigo))).map(x=>x._id));
  if(naoDetetados.length){
    const lst=naoDetetados.map(n=>'• '+n.artigo+(n.qtd?' ('+n.qtd+')':'')).join('\n');
    if(!confirm(`⚠️ Estes artigos do carrinho não foram detetados na fatura e vão ficar na lista POR TRATAR (não são dados como comprados):\n\n${lst}\n\nRegistar a compra assim mesmo?`))return;
  }
  const compraId=compraEdit.id||('c'+Date.now());
  const compradoEm=new Date().toISOString();
  const btn=document.getElementById('shop-buy-save');btn.disabled=true;
  setSync('load','a guardar…');
  try{
    // Edição: apaga as despesas antigas desta compra (BD + local)
    if(isEdit){
      await queueWrite(()=>sbReq('DELETE',`despesas?compra_id=eq.${enc(compraId)}`));
      DATA.despesas=(DATA.despesas||[]).filter(d=>d.compraId!==compraId);
    }
    // Cria uma despesa por linha
    const payload=rows.map(r=>({evento_id:DATA._sbId,quem:who,data_desp:date,data_valor:r.data_valor,descricao:desc||'Compras',tipo:r.tipo,valor:r.valor,observacoes:r.obs||null,compra_id:compraId}));
    const ins=await queueWrite(()=>sbReq('POST','despesas',payload,{Prefer:'return=representation'}));
    payload.forEach((r,i)=>DATA.despesas.push({_id:ins&&ins[i]?ins[i].id:null,quem:r.quem,dataDesp:r.data_desp,dataValor:r.data_valor,desc:r.descricao,tipo:r.tipo,valor:r.valor,obs:r.observacoes||'',compraId:compraId}));
    // Lotes de stock: substitui os da compra e aloca por FIFO (cada lote já vê
    // as alocações dos anteriores e dos lotes de outras compras)
    if(STOCK_TABLE){
      if(isEdit){
        await queueWrite(()=>sbReq('DELETE',`stock_lotes?compra_id=eq.${enc(compraId)}`));
        DATA.stockLotes=stockArr().filter(l=>l.compraId!==compraId);
      }
      if(lotes.length){
        for(const l of lotes){
          // Resolve pelo destino/split escolhido; sem destino cai em FIFO (que
          // já vê os lotes anteriores empilhados nesta mesma gravação)
          l.alocacoes=resolveLoteAlocs(l);
          stockArr().push({_id:null,compraId,artigo:l.artigo,qtd:l.qtd,unidade:l.unidade,valor:l.valor,alocacoes:l.alocacoes,criadoEm:new Date().toISOString()});
        }
        const lres=await queueWrite(()=>sbReq('POST','stock_lotes',lotes.map(l=>({evento_id:DATA._sbId,compra_id:compraId,artigo:l.artigo,qtd:l.qtd,unidade:l.unidade,valor:l.valor,alocacoes:l.alocacoes})),{Prefer:'return=representation'}));
        if(Array.isArray(lres)){
          const added=stockArr().filter(l=>l.compraId===compraId&&l._id==null);
          added.forEach((l,i)=>{if(lres[i])l._id=lres[i].id;});
        }
      }
    }
    // Artigos: os marcados ficam comprados; os que estavam ligados e foram desmarcados voltam à lista
    const prevLinked=shopArr().filter(x=>x.compraId===compraId).map(x=>x._id);
    // Os não detetados (sem preço) saem do "comprar" → ficam pendentes na lista
    const toBuy=checkedIds.filter(id=>!missIds.has(id));
    const toRelease=prevLinked.filter(id=>!toBuy.includes(id));
    if(toBuy.length){
      await queueWrite(()=>sbReq('PATCH',`shoplist?id=in.(${toBuy.join(',')})`,{estado:'comprado',compra_id:compraId,cf_desc:desc||'Compras',comprado_em:compradoEm,no_carrinho:false}));
      shopArr().forEach(it=>{if(toBuy.includes(it._id))Object.assign(it,{estado:'comprado',compraId,cfDesc:desc||'Compras',compradoEm,noCarrinho:false});});
    }
    if(toRelease.length){
      await queueWrite(()=>sbReq('PATCH',`shoplist?id=in.(${toRelease.join(',')})`,{estado:'pendente',compra_id:null,cf_desc:null,comprado_em:null}));
      shopArr().forEach(it=>{if(toRelease.includes(it._id))Object.assign(it,{estado:'pendente',compraId:null,cfDesc:null,compradoEm:null});});
    }
    syncMirror();marcaGuardado();
    btn.disabled=false;closeShopBuyModal();
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));renderAll();
    toast(isEdit?'Compra atualizada ✓':'Compra registada ✓','ok');
  }catch(e){setSync('err','erro ao guardar');btn.disabled=false;toast(permErrorMsg(e),'bad');}
}

/* ── Detalhe / alocação de um ARTIGO em stock (menu de ajustes do admin) ──
   Opera sobre TODOS os lotes do artigo de uma vez: mostra o total em stock
   (qtd · €) e as alocações agregadas por destino. O admin edita ao nível do
   artigo (sem se preocupar com as compras de origem) e, ao guardar, a app
   distribui as alocações pelos lotes por FIFO (compra mais antiga primeiro).
   O que não estiver alocado fica na bolsa comum. */
let editingLote=null;   // {artigo,u,ids:[loteIds FIFO],totQ,totV,alocs:[{tipo,data,qtd}]}
// Lotes do mesmo artigo (e unidade), por ordem FIFO da data da compra
function stockLotesDoArtigo(artigo,u){
  const dataDe=l=>((DATA.despesas||[]).find(d=>d.compraId===l.compraId)||{}).dataDesp||'';
  return stockArr().filter(l=>stockBacked(l)&&shopSameArtigo(l.artigo,artigo)&&(l.unidade||'')===(u||''))
    .sort((a,b)=>dataDe(a).localeCompare(dataDe(b))||(a.criadoEm||'').localeCompare(b.criadoEm||'')||((a._id||0)-(b._id||0)));
}
function openLoteModal(id){
  const base=stockArr().find(x=>x._id===id);
  if(!base){toast('Artigo não encontrado','bad');return;}
  const lotes=stockLotesDoArtigo(base.artigo,base.unidade);
  const totQ=rnd(lotes.reduce((s,l)=>s+(+l.qtd||0),0),3);
  const totV=rnd(lotes.reduce((s,l)=>s+(+l.valor||0),0),2);
  // Alocações agregadas de todos os lotes, ordenadas cronologicamente
  const by={};
  lotes.forEach(l=>(l.alocacoes||[]).forEach(a=>{const q=+a.qtd||0;if(q<=0)return;const k=alocToDestino(a);if(k)by[k]=rnd((by[k]||0)+q,3);}));
  editingLote={artigo:base.artigo,u:base.unidade||'',ids:lotes.map(l=>l._id),totQ,totV,
    alocs:Object.keys(by).sort(destKeyCmp).map(k=>destinoAloc(k,by[k]))};
  document.getElementById('lote-title').textContent='🧺 '+base.artigo;
  // As compras de origem mostram-se aqui (saíram do cartão do ecrã principal)
  const comprasRows=lotes.map(l=>{
    const dsp=(DATA.despesas||[]).find(d=>d.compraId===l.compraId);
    const parts=[];
    if(dsp&&dsp.dataDesp)parts.push(fmtDiaMes(dsp.dataDesp));
    parts.push(escHtml(fmtQty(l.qtd,l.unidade)),eur(l.valor));
    if(dsp&&dsp.desc&&dsp.desc!=='Compras')parts.push(escHtml(dsp.desc));
    return `<div class="lote-cmp-row">🛒 ${parts.join(' · ')}</div>`;
  }).join('');
  document.getElementById('lote-info').innerHTML=
    `Em stock: <b>${escHtml(fmtQty(totQ,editingLote.u))}</b> por <b>${eur(totV)}</b>${lotes.length>1?` · ${lotes.length} compras — a distribuição pelas compras é automática (FIFO)`:''}`+
    `<div class="lote-cmps">${comprasRows}</div>`;
  const canEdit=isAdmin()&&!contasFechadas();
  ['lote-save','lote-addline'].forEach(i=>{document.getElementById(i).style.display=canEdit?'':'none';});
  loteCatFill();
  loteRenderAlocs();
  document.getElementById('lote-bg').classList.add('show');
  document.body.classList.add('no-scroll');
}
function closeLoteModal(){document.getElementById('lote-bg').classList.remove('show');document.body.classList.remove('no-scroll');editingLote=null;}
/* Categoria do artigo no detalhe do lote — grava logo ao mudar (é uma
   associação global por nome, independente das alocações deste artigo).
   Preencher um buraco pode qualquer membro; mudar é só do admin. */
function loteCatFill(){
  const wrap=document.getElementById('lote-cat-wrap');if(!wrap)return;
  if(!CATS_TABLE||!editingLote){wrap.style.display='none';return;}
  const m=ART_CATS[shopArtKey(editingLote.artigo)];
  const sel=document.getElementById('lote-cat');
  sel.innerHTML=catOptionsHtml(m?m.catId:null);
  sel.disabled=!!(m&&!isAdmin());
  sel.style.opacity=sel.disabled?'.75':'';
  wrap.style.display='';
}
async function loteCatChanged(v){
  if(!editingLote)return;
  const ok=await catUserSetMapping(editingLote.artigo,parseInt(v)||null);
  if(ok){marcaGuardado();toast('Categoria guardada ✓','ok');}
  loteCatFill();   // repõe o select se a escrita falhou/foi bloqueada
}
function loteMeals(){return (DATA.refeicoesDef||[]).filter(r=>shopIsMeal(r.ref));}
function loteRenderAlocs(){
  if(!editingLote)return;
  const canEdit=isAdmin()&&!contasFechadas();
  const unit=editingLote.totQ>0?editingLote.totV/editingLote.totQ:0;
  document.getElementById('lote-alocs').innerHTML=editingLote.alocs.map((a,i)=>{
    return `<div class="lote-ln">
      ${destBtnHtml(alocToDestino(a),`loteDestPick(${i})`,!canEdit)}
      <input type="number" step="any" min="0" inputmode="decimal" ${canEdit?'':'disabled'} value="${a.qtd||''}" placeholder="qtd" onchange="loteAlocField(${i},'qtd',this.value)">
      <span class="lote-val">${eur(rnd(unit*(+a.qtd||0),2))}</span>
      ${canEdit?`<button class="cmp-ln-del" title="Remover" onclick="loteDelAloc(${i})">✕</button>`:''}
    </div>`;
  }).join('')||'<div class="empty sf" style="margin-top:8px">Sem alocações — está tudo na bolsa comum.</div>';
  const tot=editingLote.alocs.reduce((s,a)=>s+(+a.qtd||0),0);
  const livre=rnd(editingLote.totQ-tot,3);
  document.getElementById('lote-resto').innerHTML=livre>0
    ?`Alocado ${escHtml(fmtQty(rnd(tot,3),editingLote.u))} de ${escHtml(fmtQty(editingLote.totQ,editingLote.u))} — <b>${escHtml(fmtQty(livre,editingLote.u))}</b> (${eur(rnd(unit*livre,2))}) fica na bolsa comum.`
    :livre<0?`⚠️ Alocaste ${escHtml(fmtQty(rnd(tot,3),editingLote.u))} — mais do que há em stock (${escHtml(fmtQty(editingLote.totQ,editingLote.u))}).`
    :'Stock totalmente alocado.';
}
function loteAlocField(i,f,v){
  const a=editingLote&&editingLote.alocs[i];if(!a)return;
  if(f==='qtd')a.qtd=parseFloat(String(v).replace(',','.'))||0;
  else{const d=destinoAloc(v,0);a.tipo=d?d.tipo:v;a.data=d?d.data:null;}
  loteRenderAlocs();
}
function loteDestPick(i){
  if(!isAdmin())return;
  const a=editingLote&&editingLote.alocs[i];if(!a)return;
  openDestPicker(alocToDestino(a),v=>loteAlocField(i,'ref',v),'Alocar a');
}
/* Sugestão para uma linha de alocação NOVA: a próxima refeição que ainda pede
   este artigo na lista de compras (procura por satisfazer), por ordem de data,
   com a qtd em falta já pré-preenchida (limitada ao stock ainda livre). Ignora
   refeições que já têm linha no modal. null se não houver procura em aberto. */
function loteSuggestAloc(){
  if(!editingLote)return null;
  const dem=stockDemandFor(editingLote.artigo,editingLote.u);
  const used=new Set(editingLote.alocs.map(a=>alocToDestino(a)));
  const keys=Object.keys(dem).filter(k=>!used.has(k)&&dem[k]>0.0005)
    .sort((a,b)=>(a.split('|')[1]).localeCompare(b.split('|')[1])||a.localeCompare(b));
  if(!keys.length)return null;
  const [tipo,data]=keys[0].split('|');
  const usado=editingLote.alocs.reduce((s,a)=>s+(+a.qtd||0),0);
  const livre=Math.max(0,rnd(editingLote.totQ-usado,3));
  return {tipo,data,qtd:rnd(Math.min(dem[keys[0]],livre),3)};
}
function loteAddAloc(){
  if(!isAdmin()||!editingLote)return;
  // 1.ª escolha: sugerir logo a refeição que ainda precisa deste artigo, com a
  // qtd em falta pré-preenchida — poupa procurar a refeição e a quantidade.
  const sug=loteSuggestAloc();
  if(sug){editingLote.alocs.push(sug);loteRenderAlocs();return;}
  // Sem procura em aberto: refeição livre por preencher, senão um tipo puro (Gerais)
  const used=new Set(editingLote.alocs.map(a=>alocToDestino(a)));
  const m=loteMeals().find(r=>!used.has(r.ref+'|'+r.data));
  editingLote.alocs.push(m?{tipo:m.ref,data:m.data,qtd:0}:{tipo:'Gerais',data:null,qtd:0});
  loteRenderAlocs();
}
function loteDelAloc(i){if(!editingLote)return;editingLote.alocs.splice(i,1);loteRenderAlocs();}
async function saveLote(){
  if(!isAdmin()){toast('Só o admin ajusta alocações','bad');return;}
  if(contasFechadas()){toast('Contas fechadas — o stock já não se mexe','bad');return;}
  if(!editingLote)return;
  // junta duplicados do mesmo destino (refeição ou tipo), ignora qtd 0 e valida
  const by={};
  editingLote.alocs.forEach(a=>{const q=+a.qtd||0;if(q<=0)return;const k=alocToDestino(a);if(!k)return;by[k]=rnd((by[k]||0)+q,3);});
  const alocs=Object.keys(by).sort(destKeyCmp).map(k=>destinoAloc(k,by[k]));
  const tot=alocs.reduce((s,a)=>s+a.qtd,0);
  if(tot-editingLote.totQ>0.0005){toast(`Alocaste ${fmtQty(rnd(tot,3),editingLote.u)} — só há ${fmtQty(editingLote.totQ,editingLote.u)} em stock`,'bad');return;}
  // Distribui as alocações do ARTIGO pelos lotes por FIFO: enche a compra
  // mais antiga primeiro; a sobra fica livre nos lotes mais recentes
  const lotes=editingLote.ids.map(id=>stockArr().find(l=>l._id===id)).filter(Boolean);
  const plan=lotes.map(l=>({l,cap:+l.qtd||0,alocs:[]}));
  let pi=0;
  for(const a of alocs){
    let rest=a.qtd;
    while(rest>0.0005){
      while(pi<plan.length&&plan[pi].cap<=0.0005)pi++;
      if(pi>=plan.length)break;
      const take=Math.min(plan[pi].cap,rest);
      plan[pi].alocs.push({tipo:a.tipo,data:a.data,qtd:rnd(take,3)});
      plan[pi].cap=rnd(plan[pi].cap-take,3);
      rest=rnd(rest-take,3);
    }
  }
  const btn=document.getElementById('lote-save');btn.disabled=true;
  setSync('load','a guardar…');
  try{
    for(const p of plan){
      await queueWrite(()=>sbReq('PATCH',`stock_lotes?id=eq.${p.l._id}`,{alocacoes:p.alocs}));
      p.l.alocacoes=p.alocs;
    }
    syncMirror();marcaGuardado();
    btn.disabled=false;closeLoteModal();
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();
    if(TAB!=='compras')renderCompras();
    if(STOCK_TABLE&&TAB!=='stock')renderStock();
    toast('Alocação atualizada ✓','ok');
  }catch(e){setSync('err','erro ao guardar');btn.disabled=false;toast(permErrorMsg(e),'bad');}
}

async function deleteCompra(){
  const compraId=compraEdit.id;if(!compraId)return;
  if(!confirm('Apagar esta compra? As despesas são removidas e os artigos voltam à lista.'))return;
  const btn=document.getElementById('shop-buy-del');btn.disabled=true;
  setSync('load','a guardar…');
  try{
    await queueWrite(()=>sbReq('DELETE',`despesas?compra_id=eq.${enc(compraId)}`));
    DATA.despesas=(DATA.despesas||[]).filter(d=>d.compraId!==compraId);
    if(STOCK_TABLE){
      await queueWrite(()=>sbReq('DELETE',`stock_lotes?compra_id=eq.${enc(compraId)}`));
      DATA.stockLotes=stockArr().filter(l=>l.compraId!==compraId);
    }
    const linked=shopArr().filter(x=>x.compraId===compraId).map(x=>x._id);
    if(linked.length){
      await queueWrite(()=>sbReq('PATCH',`shoplist?id=in.(${linked.join(',')})`,{estado:'pendente',compra_id:null,cf_desc:null,comprado_em:null}));
      shopArr().forEach(it=>{if(linked.includes(it._id))Object.assign(it,{estado:'pendente',compraId:null,cfDesc:null,compradoEm:null});});
    }
    syncMirror();marcaGuardado();
    btn.disabled=false;closeShopBuyModal();
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));renderAll();
    toast('Compra apagada','ok');
  }catch(e){setSync('err','erro ao guardar');btn.disabled=false;toast(permErrorMsg(e),'bad');}
}

/* ═══ PRESENÇAS GRID ═══ */
function renderPresencaGrid(){
  if(!DATA||!DATA.refeicoesDef||!DATA.refeicoesDef.length||!DATA.membros||!DATA.membros.length)
    return '<div class="empty sf" style="margin-top:18px">Define refeições e membros primeiro</div>';

  const refs=DATA.refeicoesDef;
  const mbrs=DATA.membros;

  // Build columns: group by day
  const days=[];const dayIdx={};
  refs.forEach((rd,i)=>{
    if(dayIdx[rd.dia]===undefined){dayIdx[rd.dia]=days.length;days.push({dia:rd.dia,data:rd.data,slots:[]});}
    // Slot key used in presencas: "Dia|Ref" but Lanche is stored as "Dia|Tarde"
    const slotKey=rd.dia+'|'+(rd.ref==='Lanche'?'Tarde':rd.ref);
    days[dayIdx[rd.dia]].slots.push({ref:rd.ref,key:slotKey,idx:i});
  });

  const totalSlots=refs.length;
  const hoje=hojeISO();
  const adm=isAdmin();

  let h='<div class="pres-section" style="margin-top:14px">';

  h+='<div class="pres-scroll">';
  h+='<table class="pres-table">';

  // Header row 1: day names spanning their slots
  h+='<thead><tr><th class="pres-corner"></th>';
  days.forEach(d=>{
    const isToday=d.data===hoje;
    const isPast=d.data<hoje;
    h+=`<th class="pres-day-hdr sf${isToday?' today':''}${isPast&&!adm?' past':''}" colspan="${d.slots.length}">${d.dia}<div class="pres-date" style="color:${isToday?'var(--gold)':'var(--faint)'}">${isToday?'hoje':fmtDiaMes(d.data)}</div></th>`;
  });
  h+='<th class="pres-day-hdr sf"></th></tr>';

  // Header row 2: ref names
  h+='<tr><th class="pres-corner"></th>';
  days.forEach(d=>{
    d.slots.forEach(s=>{
      h+=`<th class="pres-ref-hdr sf">${mealIco(s.ref,16)}</th>`;
    });
  });
  h+='<th class="pres-ref-hdr sf" style="color:var(--muted)"></th></tr>';

  // Linha-resumo: total que come (membros + convidados) por refeição — fica junto ao cabeçalho
  h+='<tr><th class="pres-corner pres-sum-corner sf">Total</th>';
  let sumComeAll=0;
  days.forEach(d=>{
    d.slots.forEach(s=>{
      const memCome=mbrs.filter(m=>presModo(m,s.key)==='come').length;
      const parts=s.key.split('|');
      const slotDia=parts[0];
      const slotRef=parts[1]==='Tarde'?'Lanche':parts[1];
      const gCount=(DATA.convidados||[]).filter(g=>g.dia===slotDia&&g.ref===slotRef).length;
      const total=memCome+gCount;
      sumComeAll+=total;
      h+=`<th class="pres-sum sf${total>0?' has':''}">${total||'—'}</th>`;
    });
  });
  h+='<th class="pres-sum sf"></th>';
  h+='</tr>';

  h+='</thead>';

  // Member rows
  h+='<tbody>';
  h+='<tr class="pres-gap"><td colspan="'+(totalSlots+2)+'"></td></tr>';
  // Ordem das linhas: próprio → cônjuge → restantes (alfabética), igual ao Resumo.
  // Preserva-se o índice original (oi) porque togglePresenca/data-member dependem dele.
  const _meuP=meuNomePrincipal();
  const _conjP=MY_NAMES.filter(n=>n!==_meuP);
  const _rankP=n=>n===_meuP?0:(_conjP.includes(n)?1:2);
  const mbrsOrd=mbrs.map((m,oi)=>({m,oi})).sort((a,b)=>{
    const ra=_rankP(a.m.nome),rb=_rankP(b.m.nome);
    if(ra!==rb)return ra-rb;
    return a.m.nome.localeCompare(b.m.nome,'pt');
  });
  const _hasMine=mbrsOrd.some(x=>_rankP(x.m.nome)<2);
  let _sepDone=false,_selfDone=false;
  mbrsOrd.forEach(({m,oi})=>{
    const mi=oi;
    const _r=_rankP(m.nome);
    const _rowCls=[];
    if(_hasMine&&!_selfDone&&_r<2){_rowCls.push('pres-row-self');_selfDone=true;}
    if(_hasMine&&!_sepDone&&_r===2){_rowCls.push('pres-row-other1');_sepDone=true;}
    const pres=m.presencas||[];
    const memberCount=pres.length;
    h+=`<tr${_rowCls.length?` class="${_rowCls.join(' ')}"`:''}>`;
    const meu=MY_NAMES.includes(m.nome);
    h+=`<td class="pres-name"><div class="pres-name-inner"><div class="pres-name-av" style="background:${AVCOL[mi%AVCOL.length]}">${m.nome.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase()}</div><span class="pres-name-txt sf">${m.nome}</span></div></td>`;
    days.forEach(d=>{
      const isToday=d.data===hoje;
      const pode=adm||(meu&&d.data>=hoje);
      d.slots.forEach(s=>{
        const modo=presModo(m,s.key);
        const cls=modo==='bebe'?' bebe':(modo==='come'?' on':'');
        h+=`<td class="pres-cell${isToday?' today':''}"><button class="pres-btn${cls}${pode?'':' locked'}" data-member="${mi}" data-slot="${s.key}"${pode?` onclick="togglePresenca(${mi},'${s.key}',this)"`:''}>${modo==='bebe'?BEER_SVG:''}</button></td>`;
      });
    });
    h+=`<td class="pres-member-count sf${memberCount===totalSlots?' full':''}">${memberCount}/${totalSlots}</td>`;
    h+='</tr>';
  });
  h+='</tbody>';

  // ── Rodapé: totalizadores agrupados (que comem · só bebem) ──
  // Grupo "Que comem" — linha grossa de separação por cima
  h+='<tfoot>';
  h+='<tr><td class="pres-name pres-foot-top" style="border-bottom:none"><span class="sf pres-foot-h">Que comem</span></td>';
  days.forEach(d=>d.slots.forEach(()=>{h+='<td class="pres-count sf pres-foot-topcell"></td>';}));
  h+='<td class="pres-count sf pres-foot-topcell"></td></tr>';

  // Membros que comem
  h+='<tr><td class="pres-name pres-foot-cell" style="border-bottom:none"><span class="sf pres-foot-sub">Membros</span></td>';
  days.forEach(d=>{d.slots.forEach(s=>{const count=mbrs.filter(m=>presModo(m,s.key)==='come').length;h+=`<td class="pres-count sf${count>0?' has':''}">${count}</td>`;});});
  h+='<td class="pres-count sf"></td></tr>';

  // Convidados (também comem)
  let totalGuestAll=0;
  h+='<tr><td class="pres-name pres-foot-cell" style="border-bottom:none"><span class="sf pres-foot-sub">Convidados</span></td>';
  days.forEach(d=>{d.slots.forEach(s=>{const parts=s.key.split('|');const slotDia=parts[0];const slotRef=parts[1]==='Tarde'?'Lanche':parts[1];const guestCount=(DATA.convidados||[]).filter(g=>g.dia===slotDia&&g.ref===slotRef).length;totalGuestAll+=guestCount;h+=`<td class="pres-count sf${guestCount>0?' has':''}" style="${guestCount>0?'color:var(--gold)':''}">${guestCount||'—'}</td>`;});});
  h+='<td class="pres-count sf"></td></tr>';

  // Grupo "Só bebem" — linha leve de separação por cima
  let totalBebeAll=0;
  const bebeRow=days.map(d=>d.slots.map(s=>{const c=mbrs.filter(m=>presModo(m,s.key)==='bebe').length;totalBebeAll+=c;return c;})).flat();
  h+='<tr><td class="pres-name pres-foot-mid" style="border-bottom:none"><span class="sf pres-foot-h">Só bebem</span></td>';
  days.forEach(d=>d.slots.forEach(()=>{h+='<td class="pres-count sf pres-foot-midcell"></td>';}));
  h+='<td class="pres-count sf pres-foot-midcell"></td></tr>';

  // Membros que só bebem
  let bi=0;
  h+='<tr><td class="pres-name pres-foot-cell" style="border-bottom:none"><span class="sf pres-foot-sub">Membros</span></td>';
  days.forEach(d=>{d.slots.forEach(()=>{const c=bebeRow[bi++];h+=`<td class="pres-count sf${c>0?' has':''}" style="${c>0?'color:var(--blue)':''}">${c||'—'}</td>`;});});
  h+='<td class="pres-count sf"></td></tr>';

  h+='</tfoot></table></div>';
  h+='</div>';
  return h;
}

/* ═══ GUEST SECTION IN PRESENÇAS ═══ */
let guestFilterMember='all';
let guestFilterMeal='all';
function setGuestMeal(k){guestFilterMeal=(guestFilterMeal===k?'all':k);renderAll();}

function renderGuestSection(){
  if(!DATA||!DATA.convidados)return'';
  let h='<div class="pres-guest-section">';
  h+='<div class="sec-title sf" style="margin-top:18px">Convidados</div>';
  if(!DATA.convidados.length){
    h+='<div class="empty sf">Nenhum convidado registado</div>';
  } else {
    // Filter by member
    const membersWithGuests=[...new Set(DATA.convidados.map(g=>g.membro))].sort((a,b)=>a.localeCompare(b,'pt'));
    h+='<div class="guest-filter sf"><select onchange="guestFilterMember=this.value;renderAll()">';
    h+=`<option value="all"${guestFilterMember==='all'?' selected':''}>Todos os membros</option>`;
    membersWithGuests.forEach(m=>{h+=`<option value="${m}"${guestFilterMember===m?' selected':''}>${m}</option>`;});
    h+='</select></div>';

    // Base de convidados conforme o filtro de membro ativo
    const baseGuests=guestFilterMember==='all'?DATA.convidados:DATA.convidados.filter(g=>g.membro===guestFilterMember);
    const refOrd={Almoço:0,Lanche:1,Jantar:2};
    // Todas as refeições viram chip no filtro (mesmo as que têm 0 convidados)
    const mealChips=(DATA.refeicoesDef||[]).slice()
      .sort((a,b)=>a.data.localeCompare(b.data)||(refOrd[a.ref]||0)-(refOrd[b.ref]||0))
      .map(rd=>({rd,key:rd.dia+'|'+rd.ref,n:baseGuests.filter(g=>g.dia===rd.dia&&g.ref===rd.ref).length}));
    // Se o filtro de refeição apontar para algo sem convidados (ex: mudou o membro), volta a "Todas"
    if(guestFilterMeal!=='all' && !mealChips.some(x=>x.key===guestFilterMeal)) guestFilterMeal='all';

    let filtered=baseGuests.map(g=>({...g,_idx:DATA.convidados.indexOf(g)}));
    if(guestFilterMeal!=='all') filtered=filtered.filter(g=>g.dia+'|'+g.ref===guestFilterMeal);

    // Sort by date then meal order (Almoço < Lanche < Jantar)
    const diaToDate={};
    (DATA.refeicoesDef||[]).forEach(rd=>{diaToDate[rd.dia]=rd.data;});
    filtered.sort((a,b)=>{
      const dateA=diaToDate[a.dia]||a.dia;
      const dateB=diaToDate[b.dia]||b.dia;
      const dc=dateA.localeCompare(dateB);
      if(dc!==0)return dc;
      return(refOrd[a.ref]||0)-(refOrd[b.ref]||0);
    });

    // Cards de refeição (filtro) — uma linha. Todas as refeições, mesmo as de 0 convidados.
    if(mealChips.length){
      h+='<div class="guest-meal-chips sf">';
      h+=`<button class="guest-meal-chip gmc-all${guestFilterMeal==='all'?' on':''}" onclick="setGuestMeal('all')"><span class="gmc-dia">Todas</span><span class="gmc-ref gmc-all-ref">Total</span><span class="gmc-badge">${baseGuests.length}</span></button>`;
      mealChips.forEach(({rd,key,n})=>{
        const rc={'Almoço':'almoco','Lanche':'lanche','Jantar':'jantar'}[rd.ref]||'';
        h+=`<button class="guest-meal-chip${guestFilterMeal===key?' on':''}${n===0?' empty':''}" onclick="setGuestMeal('${key}')">
          <span class="gmc-dia">${rd.dia}</span>
          <span class="gmc-ref r-${rc}">${rd.ref}</span>
          <span class="gmc-badge">${n}</span>
        </button>`;
      });
      h+='</div>';
    }

    // Group by day/ref
    let currentGroup='';
    filtered.forEach(g=>{
      const groupKey=`${g.dia} · ${g.ref}`;
      if(groupKey!==currentGroup){
        currentGroup=groupKey;
        const icon=mealIco(g.ref,14);
        h+=`<div style="font-size:11px;color:var(--gold);font-weight:700;letter-spacing:.1em;text-transform:uppercase;margin:12px 0 6px;display:flex;align-items:center;gap:6px" class="sf"><span>${icon}</span>${diaExtenso(diaToDate[g.dia]||g.data)||g.dia} · ${g.ref}</div>`;
      }
      const paysBadge=g.pagante==='Sim'?'':'<span class="pg-badge free sf">Oferta</span>';
      h+=`<div class="pres-guest-card">
        <div class="pg-info sf">
          <span class="pg-name">${g.nome}</span>
          <span class="pg-meta">convidado por ${g.membro}</span>
        </div>
        ${paysBadge}
        ${(isAdmin()||(MY_NAMES.includes(g.membro)&&diaEditavel(g.dia)))?`<div class="card-actions">
          <button class="card-act edit write-action" onclick="editGuest(${g._idx})" title="Editar"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>
          <button class="card-act del write-action" onclick="deleteGuest(${g._idx})" title="Remover">✕</button>
        </div>`:''}
      </div>`;
    });
  }
  h+='</div>';
  return h;
}

function myMemberOptions(sel){
  const names=(DATA&&DATA.membros||[]).map(m=>m.nome).filter(n=>MY_NAMES.includes(n));
  if(!names.length)return '<option value="">—</option>';
  return names.map(n=>`<option value="${n}"${sel===n?' selected':''}>${n}</option>`).join('');
}

function openGuestModal(){
  // Build a simple modal for adding guests
  const allDays=[...new Set((DATA.refeicoesDef||[]).map(r=>r.dia))];
  const days=isAdmin()?allDays:allDays.filter(d=>diaEditavel(d));
  if(!days.length){toast('Já não há dias abertos para registar convidados','bad');return;}
  const refs=[...new Set((DATA.refeicoesDef||[]).map(r=>r.ref))];
  let html=`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <h3 style="margin-bottom:0">Adicionar Convidado</h3>
    <button onclick="this.closest('.modal-bg').classList.remove('show');document.body.classList.remove('no-scroll')" style="background:var(--panel2);border:1px solid var(--line);color:var(--muted);border-radius:9px;width:32px;height:32px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">✕</button>
  </div>
  <label>Nome do convidado</label>
  <input type="text" id="guest-nome" placeholder="Nome">
  <label>Trazido por</label>
  <select id="guest-membro">${isAdmin()?memberOptions():myMemberOptions()}</select>
  <div class="inline-row" style="margin-top:14px">
    <div><label>Dia</label>
      <select id="guest-dia">${days.map(d=>`<option value="${d}">${d}</option>`).join('')}</select>
    </div>
    <div><label>Refeição</label>
      <select id="guest-ref">${refs.map(r=>`<option value="${r}">${r}</option>`).join('')}</select>
    </div>
  </div>
  <label>Pagante?</label>
  <select id="guest-pagante"><option value="Sim">Sim — paga a quota</option><option value="Não">Não — é oferta</option></select>
  <div class="mbtns"><button class="btn prim" onclick="saveGuest()">Guardar</button></div>`;
  // Reuse a dynamic modal
  let bg=document.getElementById('guest-modal-bg');
  if(!bg){
    bg=document.createElement('div');bg.id='guest-modal-bg';bg.className='modal-bg';
    bg.innerHTML='<div class="modal" id="guest-modal-inner"></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click',e=>{if(e.target===bg){bg.classList.remove('show');document.body.classList.remove('no-scroll');}});
  }
  document.getElementById('guest-modal-inner').innerHTML=html;
  bg.classList.add('show');
  document.body.classList.add('no-scroll');
}

async function saveGuest(){
  const nome=(document.getElementById('guest-nome').value||'').trim();
  const membro=document.getElementById('guest-membro').value;
  const dia=document.getElementById('guest-dia').value;
  const ref=document.getElementById('guest-ref').value;
  const pagante=document.getElementById('guest-pagante').value;
  if(!nome){toast('Indica o nome do convidado','bad');return;}
  if(!membro){toast('Seleciona quem traz o convidado','bad');return;}
  if(!isAdmin()){
    if(!MY_NAMES.includes(membro)){toast('Só podes registar convidados teus ou do teu cônjuge','bad');return;}
    if(!diaEditavel(dia)){toast('Esse dia já passou — fala com o administrador','bad');return;}
  }
  if(!DATA._sbId){toast('Sem ligação à base de dados — recarrega a página','bad');return;}
  setSync('load','a guardar…');
  try{
    const ins=await queueWrite(()=>sbReq('POST','convidados',
      [{evento_id:DATA._sbId,membro,nome,data:null,dia,ref,pagante:pagante==='Sim',preco:0}],
      {Prefer:'return=representation'}));
    if(!DATA.convidados)DATA.convidados=[];
    DATA.convidados.push({_id:ins&&ins[0]?ins[0].id:null,nome,membro,dia,ref,pagante});
    sbLog('convidado','adicionou',nome,{membro,dia,ref,pagante});
    syncMirror();
    marcaGuardado();
    const bg=document.getElementById('guest-modal-bg');
    if(bg){bg.classList.remove('show');document.body.classList.remove('no-scroll');}
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();
    toast('Convidado adicionado ✓','ok');
  }catch(e){
    setSync('err','erro ao guardar');
    toast(permErrorMsg(e),'bad');
  }
}

async function deleteGuest(idx){
  const g=DATA.convidados[idx];
  if(!isAdmin()&&(!MY_NAMES.includes(g.membro)||!diaEditavel(g.dia))){
    toast('Só o administrador pode remover este convidado','bad');return;
  }
  if(!confirm('Remover convidado '+g.nome+'?'))return;
  if(!g._id){toast('Sem ligação à base de dados — recarrega a página','bad');return;}
  setSync('load','a guardar…');
  try{
    await queueWrite(()=>sbReq('DELETE',`convidados?id=eq.${g._id}`));
    DATA.convidados.splice(idx,1);
    sbLog('convidado','removeu',g.nome,{membro:g.membro,dia:g.dia,ref:g.ref});
    syncMirror();
    marcaGuardado();
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();
    toast('Convidado removido ✓','ok');
  }catch(e){
    setSync('err','erro ao guardar');
    toast(permErrorMsg(e),'bad');
  }
}

function editGuest(idx){
  const g=DATA.convidados[idx];
  if(!g)return;
  if(!isAdmin()&&(!MY_NAMES.includes(g.membro)||!diaEditavel(g.dia))){
    toast('Não podes editar este convidado','bad');return;
  }
  const rd=(DATA.refeicoesDef||[]).find(r=>r.dia===g.dia);
  const dataDia=diaExtenso((rd&&rd.data)||g.data)||g.dia;
  const html=`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
    <h3 style="margin-bottom:0">Editar Convidado</h3>
    <button onclick="this.closest('.modal-bg').classList.remove('show');document.body.classList.remove('no-scroll')" style="background:var(--panel2);border:1px solid var(--line);color:var(--muted);border-radius:9px;width:32px;height:32px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">✕</button>
  </div>
  <div class="sf" style="font-size:11px;color:var(--faint);margin:-4px 0 12px">${dataDia} · ${g.ref} — convidado por ${g.membro}</div>
  <label>Nome do convidado</label>
  <input type="text" id="guest-edit-nome" placeholder="Nome" value="${escHtml(g.nome)}">
  <label>Pagante?</label>
  <select id="guest-edit-pagante"><option value="Sim"${g.pagante==='Sim'?' selected':''}>Sim — paga a quota</option><option value="Não"${g.pagante!=='Sim'?' selected':''}>Não — é oferta</option></select>
  <div class="mbtns"><button class="btn prim" onclick="saveGuestEdit(${idx})">Guardar</button></div>`;
  let bg=document.getElementById('guest-modal-bg');
  if(!bg){
    bg=document.createElement('div');bg.id='guest-modal-bg';bg.className='modal-bg';
    bg.innerHTML='<div class="modal" id="guest-modal-inner"></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click',e=>{if(e.target===bg){bg.classList.remove('show');document.body.classList.remove('no-scroll');}});
  }
  document.getElementById('guest-modal-inner').innerHTML=html;
  bg.classList.add('show');
  document.body.classList.add('no-scroll');
}

async function saveGuestEdit(idx){
  const g=DATA.convidados[idx];
  if(!g)return;
  const nome=(document.getElementById('guest-edit-nome').value||'').trim();
  const pagante=document.getElementById('guest-edit-pagante').value;
  if(!nome){toast('Indica o nome do convidado','bad');return;}
  if(!isAdmin()&&(!MY_NAMES.includes(g.membro)||!diaEditavel(g.dia))){
    toast('Não podes editar este convidado','bad');return;
  }
  const bg=document.getElementById('guest-modal-bg');
  if(nome===g.nome&&pagante===g.pagante){
    if(bg){bg.classList.remove('show');document.body.classList.remove('no-scroll');}
    return;
  }
  if(!g._id){toast('Sem ligação à base de dados — recarrega a página','bad');return;}
  setSync('load','a guardar…');
  const _ant={nome:g.nome,pagante:g.pagante};
  try{
    await queueWrite(()=>sbReq('PATCH',`convidados?id=eq.${g._id}`,{nome,pagante:pagante==='Sim'}));
    sbLog('convidado','editou',nome,{membro:g.membro,dia:g.dia,ref:g.ref,de:_ant,para:{nome,pagante}});
    g.nome=nome;g.pagante=pagante;
    syncMirror();
    marcaGuardado();
    if(bg){bg.classList.remove('show');document.body.classList.remove('no-scroll');}
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();
    toast('Convidado atualizado ✓','ok');
  }catch(e){
    setSync('err','erro ao guardar');
    toast(permErrorMsg(e),'bad');
  }
}

let presDebounce=null;
async function togglePresenca(memberIdx,slotKey,btn){
  if(btn.classList.contains('saving'))return;
  const m=DATA.membros[memberIdx];
  const [dia,ref]=slotKey.split('|');
  if(!canTouchPresenca(m.nome,dia)){
    toast(MY_NAMES.includes(m.nome)?'Esse dia já passou — fala com o administrador':'Só podes marcar as tuas presenças ou do teu cônjuge','bad');
    return;
  }
  if(!m._id){toast('Sem ligação à base de dados — recarrega a página','bad');return;}
  if(!m.presencas)m.presencas=[];
  const i=presIdx(m,slotKey);
  const cur=i<0?null:m.presencas[i].modo;        // null | 'come' | 'bebe'
  const next=cur===null?'come':(cur==='come'?'bebe':null);  // ciclo: vazio → come → só bebe → vazio
  // estado local otimista
  if(next===null){if(i>=0)m.presencas.splice(i,1);}
  else if(i<0)m.presencas.push({k:slotKey,modo:next});
  else m.presencas[i].modo=next;
  paintPresBtn(btn,next);
  btn.classList.add('saving');
  setSync('load','a guardar…');

  queueWrite(async()=>{
    try{
      // Upsert idempotente: converge SEMPRE a BD para o modo pretendido,
      // independentemente do estado anterior (mata os no-ops silenciosos).
      // return=representation devolve a linha afetada -> confirma que mudou.
      let mudou=false;
      if(next===null){
        const del=await sbReq('DELETE',`presencas?membro_id=eq.${m._id}&dia=eq.${enc(dia)}&ref=eq.${enc(ref)}`,undefined,{Prefer:'return=representation'});
        mudou=Array.isArray(del)&&del.length>0;   // só "removeu" se havia mesmo linha
      }else{
        const up=await sbReq('POST','presencas?on_conflict=membro_id,dia,ref',[{membro_id:m._id,dia,ref,modo:next}],{Prefer:'resolution=merge-duplicates,return=representation'});
        mudou=Array.isArray(up)&&up.length>0;
      }
      // Persiste cada toque, mas regista no histórico só a mudança líquida
      // depois de assentar (ver scheduleLogPresenca) — sem estados de passagem.
      if(mudou)scheduleLogPresenca(m,dia,ref,cur,next);
      btn.classList.remove('saving');
      marcaGuardado();
      clearTimeout(presDebounce);
      presDebounce=setTimeout(()=>{
        syncMirror();
        CALC=calcular(JSON.parse(JSON.stringify(DATA)));
        renderAll();
      },400);
      return true;
    }catch(e){
      // reverter para o estado anterior
      const j=presIdx(m,slotKey);
      if(cur===null){if(j>=0)m.presencas.splice(j,1);}
      else if(j<0)m.presencas.push({k:slotKey,modo:cur});
      else m.presencas[j].modo=cur;
      paintPresBtn(btn,cur);
      btn.classList.remove('saving');
      setSync('err','erro ao guardar');
      toast(permErrorMsg(e),'bad');
      return false;
    }
  });
}
function paintPresBtn(btn,modo){
  btn.classList.remove('on','bebe');
  if(modo==='come'){btn.classList.add('on');btn.innerHTML='';}
  else if(modo==='bebe'){btn.classList.add('bebe');btn.innerHTML=BEER_SVG;}
  else btn.innerHTML='';
}

/* ═══ REFEIÇÕES DEF CRUD ═══ */
let editingRefdef=null;

/* Menu estruturado dentro da coluna `menu` (sem migração de BD):
   linhas "Entradas: …" e "Sobremesa: …" + notas livres no resto. */
function parseMenuParts(menu){
  const out={entradas:'',sobremesa:'',outras:[]};
  (menu||'').split('\n').forEach(l=>{
    const t=l.trim();if(!t)return;
    const m=t.match(/^(entradas?|sobremesas?)\s*:\s*(.*)$/i);
    if(m&&m[2]){
      const k=m[1].toLowerCase().startsWith('entrada')?'entradas':'sobremesa';
      out[k]=out[k]?out[k]+' · '+m[2].trim():m[2].trim();
    } else out.outras.push(t);
  });
  return {entradas:out.entradas,sobremesa:out.sobremesa,outras:out.outras.join('\n')};
}
function buildMenu(entradas,sobremesa,outras){
  const L=[];
  if(entradas)L.push('Entradas: '+entradas);
  if(sobremesa)L.push('Sobremesa: '+sobremesa);
  if(outras)L.push(outras);
  return L.join('\n');
}

// Modo consulta (não-admin): bloqueia campos e remove os placeholders de exemplo
function applyRoFields(modalEl,ro){
  if(!modalEl)return;
  modalEl.classList.toggle('ro-fields',ro);
  modalEl.querySelectorAll('input,textarea').forEach(el=>{
    if(ro){
      if(el.placeholder){el.dataset.ph=el.placeholder;el.placeholder='';}
    } else if(el.dataset.ph!==undefined){
      el.placeholder=el.dataset.ph;delete el.dataset.ph;
    }
  });
}

// Opções dos selects de responsável (membros do ano; mantém valor desconhecido se existir)
function _respOptions(sel){
  let h='<option value="">— ninguém —</option>';
  const nomes=(DATA.membros||[]).map(m=>m.nome).sort((a,b)=>a.localeCompare(b,'pt'));
  if(sel&&!nomes.includes(sel))h+=`<option value="${escHtml(sel)}" selected>${escHtml(sel)}</option>`;
  nomes.forEach(n=>{h+=`<option value="${escHtml(n)}"${sel===n?' selected':''}>${escHtml(n)}</option>`;});
  return h;
}

function openRefdefModal(editIdx){
  editingRefdef=typeof editIdx==='number'?editIdx:null;
  const isEdit=editingRefdef!==null;
  document.getElementById('refdef-title').textContent=isEdit?'Detalhe da Refeição':'Adicionar Refeição';

  // Responsáveis e menu (só com a migração db/notifs.sql corrida)
  const respWrap=document.getElementById('rd-resp-wrap');
  if(respWrap)respWrap.style.display=REFDEF_RESP_COLS?'':'none';
  const menuWrap=document.getElementById('rd-menu-wrap');
  if(menuWrap)menuWrap.style.display=REFDEF_RESP_COLS?'':'none';

  if(isEdit){
    const rd=DATA.refeicoesDef[editingRefdef];
    document.getElementById('rd-resp-coz').innerHTML=_respOptions(rd.respCozinha||'');
    const mp=parseMenuParts(rd.menu||'');
    document.getElementById('rd-entradas').value=mp.entradas;
    document.getElementById('rd-sobremesa').value=mp.sobremesa;
    document.getElementById('rd-menu').value=mp.outras;
    document.getElementById('rd-data').value=rd.data||'';
    document.getElementById('rd-ref').value=rd.ref||'Jantar';
    document.getElementById('rd-prato').value=rd.prato||'';
    document.getElementById('rd-peso').value=rd.peso!=null?Number((rd.peso*100).toFixed(2)):0;
    document.getElementById('rd-minmeo').value=rd.minMEO||0;
    document.getElementById('rd-minconv').value=rd.minConv||10;
    document.getElementById('rd-extraconv').value=rd.extraConv||2;
  } else {
    document.getElementById('rd-resp-coz').innerHTML=_respOptions('');
    document.getElementById('rd-entradas').value='';
    document.getElementById('rd-sobremesa').value='';
    document.getElementById('rd-menu').value='';
    document.getElementById('rd-data').value='';
    document.getElementById('rd-ref').value='Jantar';
    document.getElementById('rd-prato').value='';
    document.getElementById('rd-peso').value='0';
    document.getElementById('rd-minmeo').value='0';
    document.getElementById('rd-minconv').value='10';
    document.getElementById('rd-extraconv').value='2';
  }

  document.getElementById('rd-del').style.display=(isEdit&&isAdmin())?'':'none';
  applyRoFields(document.getElementById('refdef-modal'),!isAdmin());
  document.getElementById('refdef-bg').classList.add('show');
  document.body.classList.add('no-scroll');
}

function closeRefdefModal(){
  document.getElementById('refdef-bg').classList.remove('show');
  document.body.classList.remove('no-scroll');
  editingRefdef=null;
}

function editRefdef(idx){openRefdefModal(idx);}

function dataToDia(dateStr){
  const d=new Date(dateStr+'T12:00:00');
  return['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'][d.getDay()];
}
// Data curta no formato dd/mmm em português (ex: "8/ago"). Vazio se inválida.
function fmtDiaMes(ds){
  if(!ds)return'';
  const dt=new Date(ds+'T12:00:00');
  if(isNaN(dt))return ds;
  const mes=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][dt.getMonth()];
  return dt.getDate()+'/'+mes;
}
// Dia da semana por extenso a partir da data ISO (ex: "Sábado"). Fallback vazio se inválida.
function diaExtenso(dataStr){
  const d=new Date((dataStr||'')+'T12:00:00');
  if(isNaN(d))return'';
  const s=d.toLocaleDateString('pt-PT',{weekday:'long'});
  return s.charAt(0).toUpperCase()+s.slice(1);
}

async function saveRefdef(){
  const data=document.getElementById('rd-data').value;
  const ref=document.getElementById('rd-ref').value;
  const prato=document.getElementById('rd-prato').value.trim();
  const peso=(parseFloat(document.getElementById('rd-peso').value)||0)/100;
  const minMEO=parseFloat(document.getElementById('rd-minmeo').value)||0;
  const minConv=parseFloat(document.getElementById('rd-minconv').value)||0;
  const extraConv=parseFloat(document.getElementById('rd-extraconv').value)||0;

  if(!data){toast('Seleciona uma data','bad');return;}
  const dia=dataToDia(data);
  if(!dia){toast('Data inválida','bad');return;}

  // Check duplicate (same date + ref), exclude current if editing
  const dup=DATA.refeicoesDef.findIndex((rd,i)=>rd.data===data&&rd.ref===ref&&i!==editingRefdef);
  if(dup>=0){toast(`${dia} ${ref} já existe`,'bad');return;}

  const wasEdit=editingRefdef!==null;
  const anterior=wasEdit?DATA.refeicoesDef[editingRefdef]:null;
  const respCozinha=REFDEF_RESP_COLS?(document.getElementById('rd-resp-coz').value||''):((anterior&&anterior.respCozinha)||'');
  const menu=REFDEF_RESP_COLS?buildMenu(
    (document.getElementById('rd-entradas').value||'').trim(),
    (document.getElementById('rd-sobremesa').value||'').trim(),
    (document.getElementById('rd-menu').value||'').trim()
  ):((anterior&&anterior.menu)||'');
  const entry={data,dia,ref,prato:prato||'',peso:ref==='Lanche'?null:peso,minMEO,minConv,extraConv,respCozinha,menu};

  document.getElementById('rd-save').disabled=true;
  if(wasEdit){
    DATA.refeicoesDef[editingRefdef]=entry;
  } else {
    if(!DATA.refeicoesDef)DATA.refeicoesDef=[];
    DATA.refeicoesDef.push(entry);
  }

  // Sort by date then by ref order (Almoço < Lanche < Jantar)
  const refOrd={Almoço:0,Lanche:1,Jantar:2};
  DATA.refeicoesDef.sort((a,b)=>a.data.localeCompare(b.data)||(refOrd[a.ref]||0)-(refOrd[b.ref]||0));

  const ok=await pushToGitHub((wasEdit?'Editar':'Adicionar')+' refeição: '+dia+' '+ref);
  document.getElementById('rd-save').disabled=false;
  if(ok){
    logNomeacoes(anterior,entry);
    closeRefdefModal();
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();
    toast((wasEdit?'Refeição editada':'Refeição adicionada')+' ✓','ok');
  }
}

/* Nomeações de responsáveis: regista no histórico (que alimenta o Telegram —
   o nomeado recebe a frase + a lista de quem vai e os totais). */
function resumoRefeicao(rd){
  const rkey=`${rd.dia}|${rd.ref==='Lanche'?'Tarde':rd.ref}`;
  const comem=[],bebem=[];
  (DATA.membros||[]).forEach(m=>{
    const p=(m.presencas||[]).find(x=>x.k===rkey);
    if(p)(p.modo==='bebe'?bebem:comem).push(m.nome);
  });
  const srt=a=>a.sort((x,y)=>x.localeCompare(y,'pt'));
  srt(comem);srt(bebem);
  const conv=(DATA.convidados||[]).filter(g=>g.dia===rd.dia&&g.ref===rd.ref);
  const L=[`👥 ${comem.length} a comer · ${bebem.length} só bebem · ${conv.length} convidados`];
  if(rd.prato)L.unshift('🍲 '+rd.prato);
  if(comem.length)L.push('🍽 '+comem.join(', '));
  if(bebem.length)L.push('🥤 '+bebem.join(', '));
  if(conv.length)L.push('🎟 '+conv.map(g=>g.nome+(g.membro?' ('+g.membro+')':'')).join(', '));
  if(rd.menu)L.push('📋 '+rd.menu);
  return L.join('\n');
}
function logNomeacoes(antes,depois){
  [['respCozinha','cozinha']].forEach(([k,papel])=>{
    const de=(antes&&antes[k])||'',para=depois[k]||'';
    if(de===para)return;
    if(para)sbLog('refeicao','nomeou',para,{dia:depois.dia,ref:depois.ref,papel,resumo:resumoRefeicao(depois)});
    if(de)sbLog('refeicao','retirou',de,{dia:depois.dia,ref:depois.ref,papel});
  });
}

// Eliminar a partir do detalhe (modal)
async function deleteRefdefFromModal(){
  if(editingRefdef===null)return;
  const idx=editingRefdef;
  closeRefdefModal();
  await deleteRefdef(idx);
}

async function deleteRefdef(idx){
  const rd=DATA.refeicoesDef[idx];
  if(!confirm(`Remover ${rd.dia} ${rd.ref}?`))return;
  // Also clean up presencas that reference this slot
  const slotKey=rd.dia+'|'+(rd.ref==='Lanche'?'Tarde':rd.ref);
  DATA.membros.forEach(m=>{
    if(!m.presencas)return;
    m.presencas=m.presencas.filter(p=>p.k!==slotKey);
  });
  DATA.refeicoesDef.splice(idx,1);
  const ok=await pushToGitHub('Remover refeição: '+rd.dia+' '+rd.ref);
  if(ok){
    CALC=calcular(JSON.parse(JSON.stringify(DATA)));
    renderAll();
    toast('Refeição removida ✓','ok');
  }
}

/* ═══ HERO SUB-TOTALS ═══ */
function renderHeroSubtotals(){
  if(!CALC)return;
  // Receitas breakdown
  const recItems=[];
  if(CALC.totRefMembros>0) recItems.push({label:'Refeições',val:CALC.totRefMembros});
  const guestPay=rnd(CALC.membros.reduce((a,m)=>a+m.AA,0),2);
  if(guestPay>0) recItems.push({label:'Convidados',val:guestPay});
  if(CALC.mealTot>0) recItems.push({label:'Mealheiro',val:CALC.mealTot});
  if(CALC.quotaTot>0) recItems.push({label:'Quota Extra',val:CALC.quotaTot});
  if(CALC.missaoTot>0) recItems.push({label:'Missão Poupança',val:CALC.missaoTot});

  let rh='';
  if(recItems.length>1){
    rh+=`<div class="hero-expand sf" onclick="toggleHeroDetail()"><span>ver detalhe</span><span class="he-arrow">▼</span></div>`;
    rh+='<div class="hero-detail sf">';
    recItems.forEach(it=>{rh+=`<div class="hero-detail-item"><span class="hd-lbl">${it.label}</span><span class="hd-val">${eur(it.val)}</span></div>`;});
    rh+='</div>';
  }
  document.getElementById('hero-rec-detail').innerHTML=rh;

  // Despesas breakdown
  const despItems=[];
  const tot=CALC.tot;
  const tipoOrder=['Gerais','Bebidas','Almoço','Jantar','Renda','Cerveja'];
  const allTipos=Object.keys(tot).sort((a,b)=>{const ia=tipoOrder.indexOf(a),ib=tipoOrder.indexOf(b);return(ia<0?99:ia)-(ib<0?99:ib);});
  allTipos.forEach(tipo=>{if(tot[tipo]>0) despItems.push({label:tipo,val:tot[tipo]});});

  let dh='';
  if(despItems.length>1){
    dh+=`<div class="hero-expand sf" onclick="toggleHeroDetail()"><span>ver detalhe</span><span class="he-arrow">▼</span></div>`;
    dh+='<div class="hero-detail sf">';
    despItems.forEach(it=>{dh+=`<div class="hero-detail-item"><span class="hd-lbl">${it.label}</span><span class="hd-val">${eur(it.val)}</span></div>`;});
    dh+='</div>';
  }
  document.getElementById('hero-desp-detail').innerHTML=dh;
}
// Abre/fecha em conjunto os detalhes de Receitas e Despesas
function toggleHeroDetail(){
  const exps=document.querySelectorAll('#hero-rec-detail .hero-expand, #hero-desp-detail .hero-expand');
  const dets=document.querySelectorAll('#hero-rec-detail .hero-detail, #hero-desp-detail .hero-detail');
  const abrir=[...dets].some(d=>!d.classList.contains('open'));
  exps.forEach(e=>e.classList.toggle('open',abrir));
  dets.forEach(d=>d.classList.toggle('open',abrir));
}

/* ═══ RELATÓRIOS / PDF ═══ */
function openReports(){
  let html=`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
    <h3 style="margin-bottom:0">📊 Relatórios</h3>
    <button onclick="closeReports()" style="background:var(--panel2);border:1px solid var(--line);color:var(--muted);border-radius:9px;width:32px;height:32px;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0">✕</button>
  </div>`;
  html+=`<p style="font-size:13px;color:var(--muted);margin-bottom:16px;line-height:1.5">Exporta relatórios em PDF com o detalhe do evento.</p>`;

  html+=`<div style="display:flex;flex-direction:column;gap:10px">
    <button class="btn prim" onclick="generatePDF('geral')" style="display:flex;align-items:center;justify-content:center;gap:8px">
      📄 Relatório Geral
    </button>
    <p style="font-size:11px;color:var(--faint);margin-top:-4px">Receitas, despesas, todos os cash-flows e o resumo de gastos por membro.</p>

    <div style="margin-top:6px">
      <label style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);font-weight:700;margin-bottom:6px;display:block">Relatório por Pessoa</label>
      <div style="display:flex;gap:8px">
        <select id="report-person" style="flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:9px;padding:10px 12px;color:var(--ink);font-size:14px;font-family:inherit;-webkit-appearance:none;appearance:none">
          ${CALC.membros.map(m=>`<option value="${m.nome}">${m.nome}</option>`).join('')}
        </select>
        <button class="btn prim" onclick="generatePDF('pessoa')" style="flex:0 0 auto;padding:10px 18px">📄 Gerar</button>
      </div>
      <p style="font-size:11px;color:var(--faint);margin-top:6px">Detalhe completo: contribuições, pagamentos, saldo final.</p>
    </div>
  </div>`;

  let bg=document.getElementById('report-bg');
  if(!bg){
    bg=document.createElement('div');bg.id='report-bg';bg.className='modal-bg';
    bg.innerHTML='<div class="modal" id="report-inner"></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click',e=>{if(e.target===bg)closeReports();});
  }
  document.getElementById('report-inner').innerHTML=html;
  bg.classList.add('show');
  document.body.classList.add('no-scroll');
}
function closeReports(){
  const bg=document.getElementById('report-bg');
  if(bg){bg.classList.remove('show');document.body.classList.remove('no-scroll');}
}

function fmtPdfDate(ds){
  if(!ds)return'—';
  const dt=new Date(ds+'T12:00:00');
  if(isNaN(dt))return ds;
  const mes=['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'][dt.getMonth()];
  return dt.getDate()+'/'+mes;
}
function generatePDF(type){
  const pessoa=type==='pessoa'?document.getElementById('report-person')?.value:null;
  const ms=CALC.membros;
  const ano=DATA.evento.ano||'';
  const nome=(DATA.evento.nome||'MEO').replace(/\s*\d{4}\s*/g,'').trim()||'MEO';

  // Build SVG-based PDF content as printable HTML and use browser print
  let body='';
  const css=`
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1a1a2e;padding:28px;font-size:11px;line-height:1.5;max-width:800px;margin:0 auto}
    h1{font-size:22px;font-weight:700;color:#1a1a2e;margin-bottom:2px}
    h2{font-size:15px;font-weight:700;color:#50b96e;margin:18px 0 8px;border-bottom:2px solid #50b96e;padding-bottom:4px}
    h3{font-size:13px;font-weight:700;color:#333;margin:12px 0 6px}
    .subtitle{font-size:12px;color:#666;margin-bottom:16px}
    .hero-row{display:flex;gap:16px;margin:14px 0 10px}
    .hero-box{flex:1;padding:12px;border-radius:8px;text-align:center}
    .hero-box.green{background:#e8f9f1;border:1px solid #3ecf8e}
    .hero-box.red{background:#fff0f0;border:1px solid #ff6b6b}
    .hero-box.blue{background:#eef5ff;border:1px solid #5aa9ff}
    .hero-box .hb-label{font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:#666}
    .hero-box .hb-val{font-size:20px;font-weight:700;margin-top:2px}
    .hero-box.green .hb-val{color:#2a9d6a}.hero-box.red .hb-val{color:#e04545}.hero-box.blue .hb-val{color:#3a7dd6}
    table{width:100%;border-collapse:collapse;margin:6px 0 14px;font-size:11px}
    th{background:#f4f5f7;padding:6px 8px;text-align:left;font-weight:700;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:#555;border-bottom:2px solid #ddd}
    td{padding:5px 8px;border-bottom:1px solid #eee}
    tr:last-child td{border-bottom:none}
    .pos{color:#2a9d6a;font-weight:700}.neg{color:#e04545;font-weight:700}.zero{color:#999}
    .right{text-align:right}
    table.gastos-membro th{font-size:8px;letter-spacing:.02em;padding:5px 5px;white-space:nowrap}
    table.gastos-membro td{padding:5px 5px}
    table.gastos-membro td:first-child{white-space:nowrap;font-size:10.5px}
    .section{margin-bottom:8px}
    .badge{display:inline-block;font-size:9px;font-weight:700;padding:1px 6px;border-radius:4px}
    .badge-green{background:#e8f9f1;color:#2a9d6a}.badge-red{background:#fff0f0;color:#e04545}.badge-blue{background:#eef5ff;color:#3a7dd6}
    .badge-amber{background:#fdf3e0;color:#b9831a}
    .footer{margin-top:24px;padding-top:10px;border-top:1px solid #ddd;font-size:10px;color:#999;text-align:center}
    @media print{body{padding:16px} .no-print{display:none}}
  `;

  if(type==='geral'){
    body=buildGeneralReport();
  } else {
    body=buildPersonReport(pessoa);
  }

  const docHtml=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${nome} ${ano} — Relatório</title><style>${css}</style></head><body>${body}</body></html>`;

  let ov=document.getElementById('pdfOverlay');
  if(ov) ov.remove();
  ov=document.createElement('div');
  ov.id='pdfOverlay';
  ov.style.cssText='position:fixed;inset:0;z-index:99999;background:#525659;display:flex;flex-direction:column';
  ov.innerHTML=`
    <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:#1a1a2e;color:#fff;flex:0 0 auto">
      <span style="font-weight:700;font-size:14px">${nome} ${ano} — Relatório</span>
      <div style="display:flex;gap:8px">
        <button id="pdfPrint" style="background:#50b96e;border:none;color:#1a1a2e;font-weight:700;font-size:14px;padding:8px 14px;border-radius:6px;cursor:pointer">🖨 Imprimir / Guardar PDF</button>
        <button id="pdfClose" style="background:rgba(255,255,255,.15);border:none;color:#fff;font-size:18px;padding:8px 14px;border-radius:6px;cursor:pointer">✕</button>
      </div>
    </div>
    <iframe id="pdfFrame" style="flex:1 1 auto;border:0;width:100%;background:#fff"></iframe>`;
  document.body.appendChild(ov);

  const frame=ov.querySelector('#pdfFrame');
  frame.srcdoc=docHtml;
  ov.querySelector('#pdfClose').onclick=()=>ov.remove();
  ov.querySelector('#pdfPrint').onclick=()=>{frame.contentWindow.focus();frame.contentWindow.print();};
}

function buildGeneralReport(){
  const ms=CALC.membros;
  const ano=DATA.evento.ano||'';
  const nome=(DATA.evento.nome||'MEO').replace(/\s*\d{4}\s*/g,'').trim()||'MEO';
  let h=`<h1>${nome} ${ano}</h1>`;
  h+=`<div class="subtitle">${DATA.evento.datas||''} · Tesoureiro: ${DATA.evento.tesoureiro}</div>`;

  // Hero summary
  const sg=CALC.saldoGrupo;
  h+=`<div class="hero-row">
    <div class="hero-box ${sg>=0?'green':'red'}"><div class="hb-label">Saldo</div><div class="hb-val">${eur(sg)}</div></div>
    <div class="hero-box green"><div class="hb-label">Receitas</div><div class="hb-val">${eur(CALC.totReceitas)}</div></div>
    <div class="hero-box red"><div class="hb-label">Despesas</div><div class="hb-val">${eur(CALC.totDespesas)}</div></div>
  </div>`;

  // Receitas breakdown
  h+='<h2>Receitas — Detalhe</h2><table><tr><th>Item</th><th class="right">Valor</th></tr>';
  if(CALC.quotaTot>0) h+=`<tr><td>Quota Extra</td><td class="right">${eur(CALC.quotaTot)}</td></tr>`;
  if(CALC.totRefMembros>0) h+=`<tr><td>Refeições (membros)</td><td class="right">${eur(CALC.totRefMembros)}</td></tr>`;
  const gp=rnd(ms.reduce((a,m)=>a+m.AA,0),2);
  if(gp>0) h+=`<tr><td>Convidados</td><td class="right">${eur(gp)}</td></tr>`;
  if(CALC.mealTot>0) h+=`<tr><td>Mealheiro</td><td class="right">${eur(CALC.mealTot)}</td></tr>`;
  if(CALC.missaoTot>0) h+=`<tr><td>Missão Poupança</td><td class="right">${eur(CALC.missaoTot)}</td></tr>`;
  h+=`<tr style="border-top:2px solid #ddd;font-weight:700"><td><b>Total Receitas</b></td><td class="right pos"><b>${eur(CALC.totReceitas)}</b></td></tr>`;
  h+='</table>';

  // Despesas breakdown
  h+='<h2>Despesas — Detalhe</h2><table><tr><th>Tipo</th><th class="right">Valor</th></tr>';
  const tot=CALC.tot;
  Object.keys(tot).sort().forEach(tipo=>{
    if(tot[tipo]>0) h+=`<tr><td>${tipo}</td><td class="right">${eur(tot[tipo])}</td></tr>`;
  });
  h+=`<tr style="border-top:2px solid #ddd;font-weight:700"><td><b>Total Despesas</b></td><td class="right neg"><b>${eur(CALC.totDespesas)}</b></td></tr>`;
  h+='</table>';

  // Cash-flows list — apenas despesas e mealheiros (sem pagamentos de dívidas nem reembolsos)
  const cfSubLabels={'sobras_ano_anterior':'Sobras Ano Anterior','outros':'Outros','lata':'Lata'};
  const allCf=[];
  (DATA.despesas||[]).forEach(d=>{
    const prevista=!d.dataDesp&&!d.dataValor;
    allCf.push({type:'despesa',date:d.dataDesp||d.dataValor||'',title:d.desc||'(sem descrição)',tipo:d.tipo||'',obs:d.obs||'',valor:d.valor,prevista});
  });
  (DATA.mealheiros||[]).forEach(m=>{
    allCf.push({type:'mealheiro',date:m.data||'',title:m.desc||'',tipo:cfSubLabels[m.subtipo]||m.subtipo||'Mealheiro',obs:'',valor:m.valor,prevista:false});
  });
  allCf.sort((a,b)=>(b.date||'').localeCompare(a.date||''));

  h+='<h2>Cash-Flows</h2>';
  h+='<table><tr><th>Data</th><th>Descrição</th><th class="right">Valor</th></tr>';
  allCf.forEach(cf=>{
    const badgeCls=cf.type==='mealheiro'?'badge-green':'badge-red';
    let descCell='';
    if(cf.title) descCell+=`<div>${escHtml(cf.title)}</div>`;
    const badges=[];
    if(cf.tipo) badges.push(`<span class="badge ${badgeCls}">${escHtml(cf.tipo)}</span>`);
    if(cf.prevista) badges.push(`<span class="badge badge-amber">Prevista</span>`);
    if(badges.length) descCell+=`<div${cf.title?' style="margin-top:3px"':''}>${badges.join(' ')}</div>`;
    if(cf.obs) descCell+=`<div style="color:#888;font-size:10px;margin-top:3px">📝 ${escHtml(cf.obs)}</div>`;
    if(!descCell) descCell='—';
    h+=`<tr><td>${fmtPdfDate(cf.date)}</td><td>${descCell}</td><td class="right">${eur(cf.valor)}</td></tr>`;
  });
  h+='</table>';

  // Resumo de gastos por membro (consumo próprio + convidados — sem saldos/regularizações)
  const temBebeGrupo=ms.some(m=>(m._refs||[]).some(r=>r.modo==='bebe'));
  h+='<h2>Resumo de Gastos por Membro</h2>';
  h+='<table class="gastos-membro"><tr><th>Membro</th><th class="right">Refeições</th>'+(temBebeGrupo?'<th class="right">Só bebida</th>':'')+'<th class="right">Quota</th><th class="right">Convidados</th><th class="right">Total</th></tr>';
  let gT={ref:0,bebe:0,quota:0,conv:0,tot:0};
  [...ms].map(m=>{
    const comeR=(m._refs||[]).filter(r=>r.modo!=='bebe');
    const bebeR=(m._refs||[]).filter(r=>r.modo==='bebe');
    const refe=rnd(comeR.reduce((a,x)=>a+x.p,0),2);
    const bebe=rnd(bebeR.reduce((a,x)=>a+x.p,0),2);
    const quota=rnd((m.R||0)+(m.U||0),2);
    const conv=rnd(m.AA||0,2);
    return{nome:m.nome,refe,bebe,quota,conv,tot:rnd(refe+bebe+quota+conv,2)};
  }).sort((a,b)=>b.tot-a.tot).forEach(g=>{
    gT.ref+=g.refe;gT.bebe+=g.bebe;gT.quota+=g.quota;gT.conv+=g.conv;gT.tot+=g.tot;
    h+=`<tr><td>${g.nome}${g.nome===DATA.evento.tesoureiro?' <span class="badge badge-blue">tes.</span>':''}</td>
      <td class="right">${g.refe>0?eur(g.refe):'—'}</td>
      ${temBebeGrupo?`<td class="right">${g.bebe>0?eur(g.bebe):'—'}</td>`:''}
      <td class="right">${g.quota>0?eur(g.quota):'—'}</td>
      <td class="right">${g.conv>0?eur(g.conv):'—'}</td>
      <td class="right"><b>${eur(g.tot)}</b></td></tr>`;
  });
  h+=`<tr style="border-top:2px solid #ddd;font-weight:700"><td><b>Total</b></td>
    <td class="right">${eur(rnd(gT.ref,2))}</td>
    ${temBebeGrupo?`<td class="right">${eur(rnd(gT.bebe,2))}</td>`:''}
    <td class="right">${eur(rnd(gT.quota,2))}</td>
    <td class="right">${eur(rnd(gT.conv,2))}</td>
    <td class="right">${eur(rnd(gT.tot,2))}</td></tr>`;
  h+='</table>';

  h+=`<div class="footer">Relatório gerado em ${new Date().toLocaleString('pt-PT')} · ${nome} ${ano}</div>`;
  return h;
}

function buildPersonReport(pessoa){
  const m=CALC.membros.find(x=>x.nome===pessoa);
  if(!m) return '<h1>Membro não encontrado</h1>';
  const ano=DATA.evento.ano||'';
  const evNome=(DATA.evento.nome||'MEO').replace(/\s*\d{4}\s*/g,'').trim()||'MEO';
  const isTes=m.nome===DATA.evento.tesoureiro;

  let h=`<h1>${evNome} ${ano} — ${pessoa}</h1>`;
  h+=`<div class="subtitle">${DATA.evento.datas||''} · ${isTes?'Tesoureiro':'Membro'} · Fator: ${fmtFator(m.fatorEf!=null?m.fatorEf:m.fator)}</div>`;

  // Saldo hero
  const sf=m._sfEcra;
  const cls=Math.abs(sf)<0.005?'blue':(sf>0?'green':'red');
  const saldoLabel=sf>0.005?'A receber':(sf<-0.005?'A pagar':'Saldado');
  h+=`<div class="hero-row">
    <div class="hero-box ${cls}"><div class="hb-label">${saldoLabel}</div><div class="hb-val">${eur(sf)}</div></div>
  </div>`;

  // Contribuições (refeições)
  if(m._refs.length){
    const comeR=m._refs.filter(r=>r.modo!=='bebe');
    const bebeR=m._refs.filter(r=>r.modo==='bebe');
    if(comeR.length){
      h+='<h2>Refeições</h2>';
      h+='<table><tr><th>Dia</th><th>Refeição</th><th class="right">Valor</th></tr>';
      comeR.forEach(r=>{h+=`<tr><td>${r.dia}</td><td>${r.ref}</td><td class="right">${eur(r.p)}</td></tr>`;});
      h+=`<tr style="border-top:2px solid #ddd;font-weight:700"><td colspan="2"><b>Total Refeições</b></td><td class="right"><b>${eur(rnd(comeR.reduce((a,x)=>a+x.p,0),2))}</b></td></tr>`;
      h+='</table>';
    }
    if(bebeR.length){
      h+='<h2>Só bebida</h2>';
      h+='<table><tr><th>Dia</th><th>Refeição</th><th class="right">Valor</th></tr>';
      bebeR.forEach(r=>{h+=`<tr><td>${r.dia}</td><td>${r.ref}</td><td class="right">${eur(r.p)}</td></tr>`;});
      h+=`<tr style="border-top:2px solid #ddd;font-weight:700"><td colspan="2"><b>Total Só bebida</b></td><td class="right"><b>${eur(rnd(bebeR.reduce((a,x)=>a+x.p,0),2))}</b></td></tr>`;
      h+='</table>';
    }
  }

  // Convidados
  if(m._convs.length){
    h+='<h2>Convidados</h2>';
    h+='<table><tr><th>Nome</th><th>Dia / Ref</th><th class="right">Valor</th></tr>';
    m._convs.forEach(c=>{h+=`<tr><td>${c.nome}</td><td>${c.dia} · ${c.ref}</td><td class="right">${eur(c.q)}</td></tr>`;});
    h+=`<tr style="border-top:2px solid #ddd;font-weight:700"><td colspan="2"><b>Total Convidados</b></td><td class="right"><b>${eur(m.AA)}</b></td></tr>`;
    h+='</table>';
  }

  // Quota extra
  const quotaExtra=rnd((m.R||0)+(m.U||0),2);
  if(quotaExtra>0){
    h+='<h2>Quota</h2><table>';
    if(m.R>0) h+=`<tr><td>Quota adicional (fator ${fmtFator(m.fatorEf!=null?m.fatorEf:m.fator)})</td><td class="right">${eur(m.R)}</td></tr>`;
    if(m.U>0) h+=`<tr><td>Missão poupança</td><td class="right">${eur(m.U)}</td></tr>`;
    h+=`<tr style="border-top:2px solid #ddd;font-weight:700"><td><b>Total</b></td><td class="right"><b>${eur(quotaExtra)}</b></td></tr>`;
    h+='</table>';
  }

  // Despesas adiantadas
  const totalPagoDesp=DATA.despesas.filter(x=>x.quem===m.nome).reduce((a,x)=>a+x.valor,0);
  if(totalPagoDesp>0){
    h+='<h2>Despesas Adiantadas</h2>';
    h+='<table><tr><th>Data</th><th>Descrição</th><th>Tipo</th><th class="right">Valor</th></tr>';
    DATA.despesas.filter(x=>x.quem===m.nome).forEach(d=>{
      const prevista=!d.dataDesp&&!d.dataValor;
      h+=`<tr><td>${fmtPdfDate(d.dataDesp||d.dataValor||'')}</td><td>${d.desc||'—'}${prevista?' <span class="badge badge-amber">prevista</span>':''}${d.obs?`<br><span style="color:#888;font-size:10px">📝 ${escHtml(d.obs)}</span>`:''}</td><td>${d.tipo}</td><td class="right">${eur(d.valor)}</td></tr>`;
    });
    h+=`<tr style="border-top:2px solid #ddd;font-weight:700"><td colspan="3"><b>Total</b></td><td class="right pos"><b>${eur(rnd(totalPagoDesp,2))}</b></td></tr>`;
    h+='</table>';
  }

  // Pagamentos
  const pagAll=CALC.pagamentos;
  const pagNonReemb=pagAll.filter(p=>!p.ref||!p.ref.startsWith('Reembolso'));
  const myPags=pagAll.filter(p=>p.de===m.nome||p.para===m.nome);
  if(myPags.length){
    h+='<h2>Pagamentos</h2>';
    h+='<table><tr><th>Data</th><th>De → Para</th><th>Ref</th><th class="right">Valor</th></tr>';
    myPags.forEach(p=>{
      h+=`<tr><td>${fmtPdfDate(p.data||'')}</td><td>${p.de} → ${p.para}</td><td>${(p.ref||'').slice(0,40)}</td><td class="right">${eur(p.valor)}</td></tr>`;
    });
    h+='</table>';
  }

  // Mealheiro
  const mealTotal=rnd((m.W||0)+(m.X||0),2);
  if(mealTotal>0){
    h+='<h2>Mealheiro</h2>';
    h+=`<table><tr><td>Créditos recebidos do mealheiro</td><td class="right">${eur(mealTotal)}</td></tr></table>`;
  }

  // Saldo final summary
  h+='<h2>Resumo Final</h2>';
  const pagAll2=CALC.pagamentos;
  const reembolsosRecebidos=pagAll2.filter(p=>p.ref&&p.ref.startsWith('Reembolso')&&p.para===m.nome).reduce((a,p)=>a+p.valor,0);
  const reembolsosFeitos=pagAll2.filter(p=>p.ref&&p.ref.startsWith('Reembolso')&&p.de===m.nome).reduce((a,p)=>a+p.valor,0);
  const recebimentos=pagNonReemb.filter(p=>p.para===m.nome).reduce((a,p)=>a+p.valor,0);
  const contribT=rnd(m.Sown+m.AA,2);

  let totalCreditos=totalPagoDesp;
  if(isTes) totalCreditos+=reembolsosFeitos;
  if(!isTes){
    totalCreditos+=rnd(m._payerOwnPortion,2);
    (m._creditedBy||[]).filter(c=>c.payer!==m.nome).forEach(c=>{totalCreditos+=c.amount;});
  }
  totalCreditos=rnd(totalCreditos,2);
  const totalDebitos=rnd(contribT+quotaExtra+mealTotal+recebimentos+reembolsosRecebidos,2);

  h+='<table>';
  h+=`<tr><td>Créditos</td><td class="right pos">${eur(totalCreditos)}</td></tr>`;
  h+=`<tr><td>Débitos</td><td class="right neg">${eur(totalDebitos)}</td></tr>`;
  h+=`<tr style="border-top:2px solid #ddd;font-weight:700"><td><b>Saldo Final</b></td><td class="right ${Math.abs(sf)<0.005?'zero':(sf>0?'pos':'neg')}"><b>${eur(sf)}</b></td></tr>`;
  h+='</table>';

  h+=`<div class="footer">Relatório gerado em ${new Date().toLocaleString('pt-PT')} · ${evNome} ${ano}</div>`;
  return h;
}

/* ═══ READ-ONLY MODE ═══ */
function updateReadOnlyMode(){
  document.body.classList.toggle('read-only',!_sbSession);
  document.body.classList.toggle('no-admin',!isAdmin());
  document.body.classList.toggle('no-write',!isAdmin()&&!MY_NAMES.length);
}

/* ═══ RESUMO (fundido nos SALDOS) — despesa total por membro + movimentos + saldo ═══ */
function toggleRsSub(el,ev){
  if(ev)ev.stopPropagation();
  const s=el.nextElementSibling;
  if(!s||!s.classList.contains('rs-sub'))return;
  el.classList.toggle('open');s.classList.toggle('open');
}
function saldosMembrosHtml(){
  if(!CALC)return'';
  const ms=CALC.membros;
  // parâmetros do ano (para fórmulas no detalhe)
  const BN3=rnd(CALC.BN3||0,2), sumF=CALC.sumF||0;
  const missao=DATA.evento.missaoPoupanca||0;
  const fundo=DATA.evento.fundoReserva||0;
  const arredonda=!!DATA.evento.arredondaTotal;
  const fmtF=x=>Number(x||0).toLocaleString('pt-PT',{maximumFractionDigits:2});
  // Conta efetiva da quota extra total (antes dos fatores): défice = despesas − receitas próprias (+ Fundo de Reserva) = BN3
  const cDesp=rnd(CALC.totDespesas||0,2);
  const cRef=rnd(CALC.totRefMembros||0,2);
  const cConv=rnd((CALC.membros||[]).reduce((a,m)=>a+(m.AA||0),0),2);
  const cMeal=rnd(CALC.mealTot||0,2);
  // ordem cronológica dos slots (segundo refeicoesDef)
  const ord={};(DATA.refeicoesDef||[]).forEach((rd,i)=>{ord[rd.dia+'|'+rd.ref]=i;});
  const nrm=r=>r==='Tarde'?'Lanche':r;
  const oKey=x=>ord[x.dia+'|'+nrm(x.ref)]!=null?ord[x.dia+'|'+nrm(x.ref)]:999;
  const rows=[...ms].map(m=>{
    const amigos=rnd(m.AA||0,2);
    const poup=rnd(m.U||0,2);
    const quota=rnd(m.R||0,2);
    const allR=[...(m._refs||[])].sort((a,b)=>oKey(a)-oKey(b));
    const refsCome=allR.filter(x=>x.modo!=='bebe').map(x=>({k:`${x.dia} · ${x.ref}`,v:rnd(x.p,2)}));
    const refsBebe=allR.filter(x=>x.modo==='bebe').map(x=>({k:`${x.dia} · ${x.ref}`,v:rnd(x.p,2)}));
    const refeCome=rnd(refsCome.reduce((a,x)=>a+x.v,0),2);
    const refeBebe=rnd(refsBebe.reduce((a,x)=>a+x.v,0),2);
    const convsList=[...(m._convs||[])].sort((a,b)=>oKey(a)-oKey(b)).map(x=>({k:`${x.nome} — ${x.dia} · ${x.ref}`,v:rnd(x.q,2)}));
    return{nome:m.nome,i:ms.indexOf(m),_m:m,refeCome,refeBebe,amigos,poup,quota,fator:(m.fatorEf!=null?m.fatorEf:m.fator)||0,outras:rnd(m.T||0,2),refsCome,refsBebe,convsList,tot:rnd(refeCome+refeBebe+amigos+poup+quota,2)};
  });
  // Ordem: próprio → cônjuge → restantes (ordem alfabética)
  const _meuR=meuNomePrincipal();
  const _conjR=MY_NAMES.filter(n=>n!==_meuR);
  const _rankR=n=>n===_meuR?0:(_conjR.includes(n)?1:2);
  rows.sort((a,b)=>{const ra=_rankR(a.nome),rb=_rankR(b.nome);if(ra!==rb)return ra-rb;return a.nome.localeCompare(b.nome,'pt');});
  const T=rows.reduce((a,g)=>({refeCome:a.refeCome+g.refeCome,refeBebe:a.refeBebe+g.refeBebe,amigos:a.amigos+g.amigos,poup:a.poup+g.poup,quota:a.quota+g.quota,tot:a.tot+g.tot}),{refeCome:0,refeBebe:0,amigos:0,poup:0,quota:0,tot:0});
  // agregado do grupo por dia/refeição
  const aggRCome={},aggRBebe={},aggC={};
  ms.forEach(m=>{
    (m._refs||[]).forEach(x=>{const tgt=x.modo==='bebe'?aggRBebe:aggRCome;const k=x.dia+'|'+nrm(x.ref);(tgt[k]=tgt[k]||{dia:x.dia,ref:nrm(x.ref),n:0,v:0});tgt[k].n++;tgt[k].v+=x.p;});
    (m._convs||[]).forEach(x=>{const k=x.dia+'|'+nrm(x.ref);(aggC[k]=aggC[k]||{dia:x.dia,ref:nrm(x.ref),n:0,v:0});aggC[k].n++;aggC[k].v+=x.q;});
  });
  T.refsCome=Object.values(aggRCome).sort((a,b)=>oKey(a)-oKey(b)).map(a=>({k:`${a.dia} · ${a.ref} — ${a.n} 🧑`,v:rnd(a.v,2)}));
  T.refsBebe=Object.values(aggRBebe).sort((a,b)=>oKey(a)-oKey(b)).map(a=>({k:`${a.dia} · ${a.ref} — ${a.n} 🧑`,v:rnd(a.v,2)}));
  T.convsList=Object.values(aggC).sort((a,b)=>oKey(a)-oKey(b)).map(a=>({k:`${a.dia} · ${a.ref} — ${a.n} conv.`,v:rnd(a.v,2)}));

  const expIt=(icon,lbl,total,list)=>{
    if(!list||!list.length||total<=0.005)
      return`<div class="rs-it"><span class="k">${icon} ${lbl}</span><span class="v">${total>0.005?eur(total):'—'}</span></div>`;
    return`<div class="rs-it rs-exp" onclick="toggleRsSub(this,event)"><span class="k">${icon} ${lbl}<span class="sub-arrow">▼</span></span><span class="v">${eur(total)}</span></div>
      <div class="rs-sub">${list.map(it=>`<div class="rs-sub-it"><span class="k">${it.k}</span><span class="v">${eur(it.v)}</span></div>`).join('')}</div>`;
  };
  // Quota Extra de um membro — fator + fórmula que dá o valor
  const quotaDet=g=>{
    if(g.quota<=0.005) return `<div class="rs-it"><span class="k">➕ Quota Extra</span><span class="v">—</span></div>`;
    return `<div class="rs-it rs-exp" onclick="toggleRsSub(this,event)"><span class="k">➕ Quota Extra<span class="sub-arrow">▼</span></span><span class="v">${eur(g.quota)}</span></div>
      <div class="rs-sub">
        <div class="rs-sub-it"><span class="k">Total a repartir</span><span class="v">${eur(BN3)}</span></div>
        <div class="rs-sub-it"><span class="k">Fator do membro</span><span class="v">${fmtF(g.fator)} de ${fmtF(sumF)}</span></div>
        <div class="rs-formula">${eur(BN3)} × ${fmtF(g.fator)} ÷ ${fmtF(sumF)}<span class="res">= ${eur(g.quota)}</span></div>
      </div>`;
  };
  // Poupança de um membro — decomposição (missão + outras + arredondamento)
  const poupDet=g=>{
    if(g.poup<=0.005) return `<div class="rs-it"><span class="k">🐖 Poupança</span><span class="v">—</span></div>`;
    const arred=rnd(g.poup-missao-g.outras,2);
    let li='';
    if(missao>0.005) li+=`<div class="rs-sub-it"><span class="k">Missão Poupança</span><span class="v">${eur(missao)}</span></div>`;
    if(g.outras>0.005) li+=`<div class="rs-sub-it"><span class="k">Outras contribuições</span><span class="v">${eur(g.outras)}</span></div>`;
    if(arred>0.005) li+=`<div class="rs-sub-it"><span class="k">Arredondamento</span><span class="v">${eur(arred)}</span></div>`;
    return `<div class="rs-it rs-exp" onclick="toggleRsSub(this,event)"><span class="k">🐖 Poupança<span class="sub-arrow">▼</span></span><span class="v">${eur(g.poup)}</span></div>
      <div class="rs-sub">${li}<div class="rs-formula"><span class="res">= ${eur(g.poup)}</span></div></div>`;
  };
  const _admin=isAdmin();
  const canSee=n=>_admin||!!DATA.evento.dividasPublicas||MY_NAMES.includes(n);
  // Movimentos + saldo individual (só para membros cujo saldo o utilizador pode ver)
  const mvHtml=m=>{
    if(!m||!m._mv||m._sfEcra==null||!canSee(m.nome))return'';
    const v=m._mv;
    const line=(icon,lbl,val,cls,list)=>{
      if(val<=0.005)return'';
      const vHtml=`<span class="v ${cls}">${cls==='plus'?'+':'−'} ${eur(val)}</span>`;
      if(!list||!list.length)return`<div class="rs-it"><span class="k">${icon} ${lbl}</span>${vHtml}</div>`;
      return`<div class="rs-it rs-exp" onclick="toggleRsSub(this,event)"><span class="k">${icon} ${lbl}<span class="sub-arrow">▼</span></span>${vHtml}</div>
        <div class="rs-sub">${list.map(it=>`<div class="rs-sub-it"><span class="k">${it.k}</span><span class="v">${eur(it.v)}</span></div>`).join('')}</div>`;
    };
    let li='';
    li+=line('🛒','Despesas adiantadas',v.pagoDesp,'plus',v.pagoDespL);
    if(v.isTes)li+=line('💸','Reembolsos feitos',v.reembFeitos,'plus',v.reembFeitosL);
    else{
      li+=line('🤝','Pagou para saldar',v.ownPortion,'plus');
      Object.entries(v.paidBy).forEach(([p,a])=>{li+=line('🤝',`Pago por ${p}`,a,'plus');});
    }
    li+=line('🐷','Mealheiro recebido',v.mealT,'minus',v.mealL);
    li+=line('🤝','Pagamentos recebidos',v.receb,'minus',v.recebL);
    li+=line('💸','Reembolsos recebidos',v.reembRecebidos,'minus',v.reembRecebidosL);
    const sf=m._sfEcra,zero=Math.abs(sf)<0.005;
    const cls=zero?'zero':(sf>0?'pos':'neg');
    const lblS=zero?'saldado':(sf>0?'a receber':'a pagar');
    return `${li?'<div class="rs-mv-title">Movimentos</div>'+li:''}
      <div class="rs-it rs-saldo"><span class="k">Saldo <small>${lblS}</small></span><span class="v ${cls}">${eur(zero?0:sf)}</span></div>`;
  };
  // det(g): para uma pessoa → fórmula individual + movimentos/saldo; para o grupo → contribuição de cada membro
  const det=(g,grupo)=>`<div class="rs-detail"><div class="rs-detail-inner sf">
      ${expIt('🍽','Refeições',g.refeCome,g.refsCome)}
      ${g.refeBebe>0.005?expIt('🍺','Só bebida',g.refeBebe,g.refsBebe):''}
      ${expIt('👥','Amigos',g.amigos,g.convsList)}
      ${grupo?expIt('➕','Quota Extra',g.quota,g.quotaList):quotaDet(g)}
      ${grupo?expIt('🐖','Poupança',g.poup,g.poupList):poupDet(g)}
      ${grupo?'':mvHtml(g._m)}
    </div></div>`;
  let h=`<details class="calc-help sf">
    <summary><span class="ch-ico">ⓘ</span> De onde vêm a Quota Extra e a Poupança? <span class="chev">›</span></summary>
    <div class="calc-help-body">
      <p><b>Quota Extra</b> — é calculada quando existe <b>défice</b> entre as despesas e as receitas, e é repartida por todos os membros. Não é igual para todos: cada membro tem um <b>fator</b>${DATA.evento.fatorModo==='variavel'?', calculado pelas presenças':' (definido manualmente este ano)'}.</p>
      ${DATA.evento.fatorModo==='variavel'?`<p style="font-size:12px;color:var(--muted);margin:4px 0 6px">Conta como presença ter <b>comido ou só bebido</b>. O peso de cada refeição soma 100%; o limiar para fator máximo este ano é <b>${Math.round((DATA.evento.fatorThreshold!=null?DATA.evento.fatorThreshold:0.70)*100)}%</b>.</p>`:''}
      <ul style="margin:6px 0 8px;padding-left:18px;line-height:1.55">
        <li><b>Homens</b> — ≥ limiar de presença <b>1.00</b>; veio &gt;1× <b>0.50</b>; veio 1× <b>0.25</b>; nunca <b>0</b>.</li>
        <li><b>Mulheres</b> — ≥ limiar <b>0.25</b>; veio &gt;1× <b>0.20</b>; veio 1× <b>0.10</b>; nunca <b>0</b>.</li>
      </ul>
      <p style="font-variant-numeric:tabular-nums">Total a repartir = <b>${eur(cDesp)}</b> <i style="color:var(--faint)">(despesas)</i> − <b>${eur(cRef)}</b> <i style="color:var(--faint)">(receita de refeições dos membros)</i> − <b>${eur(cConv)}</b> <i style="color:var(--faint)">(receita convidados)</i> − <b>${eur(cMeal)}</b> <i style="color:var(--faint)">(receita mealheiros)</i> + <b>${eur(fundo)}</b> <i style="color:var(--faint)">(fundo de reserva)</i> = <b>${eur(BN3)}</b>.</p>
      <p style="font-variant-numeric:tabular-nums">Quota do membro = <b>${eur(BN3)}</b> × fator ÷ soma dos fatores.</p>
      <p style="border-top:1px solid var(--line);padding-top:9px"><b>Poupança</b> — sobre o valor final de cada membro (já depois da quota extra) acrescem dois valores:</p>
      <ul style="margin:6px 0 0;padding-left:18px;line-height:1.55">
        <li><b>Missão Poupança</b> — valor fixo por ano (<b>${eur(missao)}</b> este ano).</li>
        <li><b>Arredondamento</b> — arredonda o total a pagar à unidade seguinte, gerando entre <b>0,01€</b> e <b>0,99€</b> por membro${arredonda?'':' <span style="color:var(--muted)">(desligado este ano)</span>'}.</li>
      </ul>
    </div>
  </details>`;
  h+='<div class="sec-title sf">Despesa e Saldo por Membro</div><div class="mlist">';
  if(!_admin&&!MY_NAMES.length&&rows.length) h+='<div class="empty sf" style="margin-bottom:10px">Liga a tua conta a um membro nas Definições para veres o teu saldo.</div>';
  if(!rows.length) h+='<div class="empty sf">Sem membros.</div>';
  let _prevRk=null;
  rows.forEach(g=>{
    const _rk=_rankR(g.nome);
    if(_prevRk!==null&&_prevRk<2&&_rk===2)h+='<div class="rs-divider sf"></div>';
    _prevRk=_rk;
    const tag=g.nome===DATA.evento.tesoureiro?' · tesoureiro':'';
    let sub='despesa total'+tag,saldoHtml='';
    if(canSee(g.nome)&&g._m&&g._m._sfEcra!=null){
      const sf=g._m._sfEcra,zero=Math.abs(sf)<0.005;
      sub=(zero?'sem dívida':(sf>0?'a receber':'a pagar'))+tag;
      saldoHtml=`<div class="amt-saldo ${zero?'zero':(sf>0?'pos':'neg')}">${eur(zero?0:sf)}</div>`;
    }
    h+=`<div class="rs-row">
      <div class="rs-head" onclick="this.parentElement.classList.toggle('open')">
        ${av(g.nome,g.i)}<div class="nm">${g.nome}<small>${sub}</small></div>
        <div class="amt-col"><div class="amt">${eur(g.tot)}</div>${saldoHtml}</div><span class="rs-arrow">▼</span>
      </div>${det(g)}</div>`;
  });
  if(rows.length){
    const quotaList=rows.filter(g=>g.quota>0.005).map(g=>({k:g.nome,v:g.quota}));
    const poupList=rows.filter(g=>g.poup>0.005).map(g=>({k:g.nome,v:g.poup}));
    h+=`<div class="rs-row rs-grand">
      <div class="rs-head" onclick="this.parentElement.classList.toggle('open')">
        <div class="av" style="background:var(--gold)">Σ</div>
        <div class="nm">Total do Grupo<small>${rows.length} membros</small></div>
        <div class="amt">${eur(rnd(T.tot,2))}</div><span class="rs-arrow">▼</span>
      </div>${det({refeCome:rnd(T.refeCome,2),refeBebe:rnd(T.refeBebe,2),amigos:rnd(T.amigos,2),poup:rnd(T.poup,2),quota:rnd(T.quota,2),refsCome:T.refsCome,refsBebe:T.refsBebe,convsList:T.convsList,quotaList,poupList},true)}</div>`;
  }
  h+='</div>';
  return h;
}

/* ═══ DRAGGABLE FABs ═══ */
(function(){
  const fab=document.getElementById('fab-container');
  const handle=document.getElementById('fab-drag');
  if(!fab||!handle)return;

  let isDragging=false,startY=0,startBottom=0;
  const savedPos=localStorage.getItem('meo_fab_pos');
  if(savedPos){
    const pos=JSON.parse(savedPos);
    fab.style.bottom=pos.bottom+'px';
    fab.style.right=pos.right+'px';
  }

  function onStart(e){
    isDragging=true;
    fab.classList.add('dragging');
    const touch=e.touches?e.touches[0]:e;
    startY=touch.clientY;
    const rect=fab.getBoundingClientRect();
    startBottom=window.innerHeight-rect.bottom;
    e.preventDefault();
  }
  function onMove(e){
    if(!isDragging)return;
    const touch=e.touches?e.touches[0]:e;
    const deltaY=touch.clientY-startY;
    let newBottom=startBottom-deltaY;
    newBottom=Math.max(8,Math.min(window.innerHeight-fab.offsetHeight-8,newBottom));
    fab.style.bottom=newBottom+'px';
    e.preventDefault();
  }
  function onEnd(){
    if(!isDragging)return;
    isDragging=false;
    fab.classList.remove('dragging');
    localStorage.setItem('meo_fab_pos',JSON.stringify({
      bottom:parseInt(fab.style.bottom)||18,
      right:parseInt(fab.style.right)||16
    }));
  }

  handle.addEventListener('touchstart',onStart,{passive:false});
  handle.addEventListener('mousedown',onStart);
  document.addEventListener('touchmove',onMove,{passive:false});
  document.addEventListener('mousemove',onMove);
  document.addEventListener('touchend',onEnd);
  document.addEventListener('mouseup',onEnd);
})();


/* ═══ AUTH (Supabase — mesmo padrão do SplitBill) ═══ */
async function sbInit(){
  const stored=localStorage.getItem(SESSION_KEY);
  if(stored){
    try{
      const s=JSON.parse(stored);
      _sbSession=s;
      // Token expirado ou quase? Tenta renovar com o refresh_token antes de validar
      if(tokenQuaseExpirado())await sbRefresh();
      let r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${_sbSession.access_token}`}});
      if(!r.ok&&_sbSession.refresh_token){
        // Última tentativa: refresh + revalidar (sessões antigas sem expires_at caem aqui)
        if(await sbRefresh())
          r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${_sbSession.access_token}`}});
      }
      if(r.ok){const u=await r.json();sbSaveSession({..._sbSession,user:u});await sbAposLogin();return;}
    }catch(e){}
    _sbSession=null;
    localStorage.removeItem(SESSION_KEY);
  }
  const hash=window.location.hash;
  if(hash.includes('access_token')){
    const params=new URLSearchParams(hash.substring(1));
    const access_token=params.get('access_token');
    const refresh_token=params.get('refresh_token');
    const expires_at=parseInt(params.get('expires_at'))||Math.floor(Date.now()/1000)+(parseInt(params.get('expires_in'))||3600);
    if(access_token){
      const r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{'apikey':SB_KEY,'Authorization':`Bearer ${access_token}`}});
      if(r.ok){
        const u=await r.json();
        sbSaveSession({access_token,refresh_token,expires_at,user:u});
        window.history.replaceState({},document.title,window.location.pathname);
        await sbAposLogin();return;
      }
    }
  }
  sbMostrarLogin();
}

function sbMostrarLogin(){
  document.getElementById('page-login').style.display='flex';
  document.getElementById('page-sem-acesso').style.display='none';
  if(window.fbvEsconderSplash)window.fbvEsconderSplash();
}

async function sbAposLogin(){
  document.getElementById('page-login').style.display='none';
  const email=_sbSession.user.email;
  let data=null;
  try{
    const r=await sbFetch(`${SB_URL}/rest/v1/allowed_users?email=eq.${encodeURIComponent(email)}&select=email`,{headers:sbHeaders()});
    if(r.ok)data=await r.json();
  }catch(e){}
  if(!Array.isArray(data)||data.length===0){
    document.getElementById('page-sem-acesso').style.display='flex';
    document.getElementById('sem-acesso-email').textContent=`Sessão iniciada como ${email}. Esta conta não tem acesso à app.`;
    if(window.fbvEsconderSplash)window.fbvEsconderSplash();
    return;
  }
  document.getElementById('page-sem-acesso').style.display='none';
  updateReadOnlyMode();
  await carregar();
  if(window.fbvEsconderSplash)window.fbvEsconderSplash();
}

async function sbLoginGoogle(){
  window.location.href=`${SB_URL}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(window.location.href.split('#')[0])}`;
}

async function sbLoginEmail(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const status=document.getElementById('login-status');
  status.style.display='block';status.textContent='A entrar…';status.style.color='var(--muted)';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/token?grant_type=password`,{method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok){status.style.color='var(--red)';status.textContent=d.error_description||d.msg||'Erro ao entrar.';return;}
    sbSaveSession({access_token:d.access_token,refresh_token:d.refresh_token,expires_at:d.expires_at||Math.floor(Date.now()/1000)+(d.expires_in||3600),user:d.user});
    await sbAposLogin();
  }catch(e){status.style.color='var(--red)';status.textContent='Erro de ligação.';}
}

async function sbRegistarEmail(){
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const status=document.getElementById('login-status');
  status.style.display='block';status.textContent='A criar conta…';status.style.color='var(--muted)';
  try{
    const r=await fetch(`${SB_URL}/auth/v1/signup`,{method:'POST',headers:{'apikey':SB_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    const d=await r.json();
    if(!r.ok){status.style.color='var(--red)';status.textContent=d.error_description||d.msg||'Erro ao criar conta.';return;}
    status.style.color='var(--green)';status.textContent='Conta criada! Confirma o email e volta a entrar.';
  }catch(e){status.style.color='var(--red)';status.textContent='Erro de ligação.';}
}

async function sbSolicitarAcesso(){
  if(!_sbSession)return;
  const btn=document.getElementById('btn-solicitar');
  const btnV=document.getElementById('btn-verificar');
  const status=document.getElementById('solicitar-status');
  btn.disabled=true;btn.textContent='A enviar…';
  try{
    // INSERT simples (sem merge-duplicates: ON CONFLICT DO UPDATE seria
    // recusado pela RLS — access_requests não tem policy de UPDATE).
    // 409 = pedido já registado anteriormente → também é sucesso.
    const r=await sbFetch(`${SB_URL}/rest/v1/access_requests`,{
      method:'POST',
      headers:sbHeaders({'Prefer':'return=minimal'}),
      body:JSON.stringify({email:_sbSession.user.email})
    });
    if(r.ok||r.status===409){
      status.style.display='block';status.style.color='var(--green)';
      status.textContent=r.status===409?'✓ O pedido já estava registado. Aguarda aprovação.':'✓ Pedido enviado! Aguarda aprovação.';
      btn.style.display='none';
      btnV.style.display='';
      return;
    }
    let msg='HTTP '+r.status;
    try{const j=await r.json();msg=j.message||msg;}catch(_){}
    if(r.status===401)msg='Sessão expirada — sai e volta a entrar.';
    status.style.display='block';status.style.color='var(--red)';
    status.textContent='Erro ao enviar pedido: '+msg;
    btn.disabled=false;btn.textContent='Solicitar acesso';
  }catch(e){
    status.style.display='block';status.style.color='var(--red)';
    status.textContent='Erro de ligação — tenta novamente.';
    btn.disabled=false;btn.textContent='Solicitar acesso';
  }
}

async function sbVerificarAcesso(){
  const btn=document.getElementById('btn-verificar');
  const status=document.getElementById('solicitar-status');
  btn.disabled=true;btn.textContent='A verificar…';
  await sbAposLogin();
  // Se chegou aqui ainda está no ecrã sem-acesso — acesso ainda não aprovado
  btn.disabled=false;btn.textContent='🔄 Verificar acesso';
  status.style.display='block';status.style.color='var(--muted)';
  status.textContent='Acesso ainda não aprovado. Tenta mais tarde.';
}

function sbLogout(){
  localStorage.removeItem(SESSION_KEY);
  _sbSession=null;
  window.location.reload();
}

async function sbRenderPedidos(){
  const box=document.getElementById('adm-pedidos-list');
  if(!box)return;
  try{
    const reqs=await sbReq('GET','access_requests?select=email,requested_at&order=requested_at.asc');
    if(!reqs||!reqs.length){box.innerHTML='<div class="note">Sem pedidos pendentes.</div>';return;}
    box.innerHTML=reqs.map(r=>`
      <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;margin-bottom:6px">
        <span style="flex:1;font-size:12.5px;color:var(--ink);word-break:break-all">${r.email}</span>
        <button class="card-act" style="color:var(--green)" title="Aprovar" onclick="sbAprovarAcesso('${r.email.replace(/'/g,"\\'")}')">✓</button>
        <button class="card-act del" title="Recusar" onclick="sbRecusarAcesso('${r.email.replace(/'/g,"\\'")}')">✕</button>
      </div>`).join('');
  }catch(e){box.innerHTML='<div class="note">Erro a carregar pedidos.</div>';}
}

async function sbAprovarAcesso(email){
  try{
    await sbReq('POST','allowed_users',{email},{Prefer:'resolution=merge-duplicates'});
    await sbReq('DELETE',`access_requests?email=eq.${encodeURIComponent(email)}`);
    toast('Acesso aprovado ✓','ok');
    sbRenderPedidos();
    sbRenderLigacoes();
  }catch(e){toast('Erro: '+e.message,'bad');}
}

async function sbRecusarAcesso(email){
  try{
    await sbReq('DELETE',`access_requests?email=eq.${encodeURIComponent(email)}`);
    toast('Pedido removido','ok');
    sbRenderPedidos();
  }catch(e){toast('Erro: '+e.message,'bad');}
}

/* ═══ UTILIZADORES ↔ MEMBROS & CASAIS (admin) ═══ */
function allMemberNames(){
  return [...new Set(ALL_YEARS.flatMap(y=>(y.membros||[]).map(m=>m.nome)))].sort((a,b)=>a.localeCompare(b,'pt'));
}

async function sbRenderLigacoes(){
  if(!isAdmin())return;
  const elL=document.getElementById('adm-ligacoes-list');
  const elC=document.getElementById('adm-casais-list');
  if(!elL||!elC)return;
  try{
    const [users,ua,cj]=await Promise.all([
      sbReq('GET','allowed_users?select=email&order=email.asc'),
      sbReq('GET','user_amigos?select=email,amigo'),
      sbReq('GET','conjuges?select=amigo_a,amigo_b')
    ]);
    USER_AMIGOS=ua||[];CONJUGES=cj||[];
    computeMyNames();updateReadOnlyMode();
    const names=allMemberNames();
    const esc=s=>s.replace(/'/g,"\\'");
    const opt=sel=>'<option value="">— sem ligação —</option>'+names.map(n=>`<option value="${n}"${sel===n?' selected':''}>${n}</option>`).join('');
    elL.innerHTML=(users||[]).map(u=>{
      const cur=(USER_AMIGOS.find(x=>x.email===u.email)||{}).amigo||'';
      return `<div class="lig-row sf">
        <span style="flex:1;font-size:12px;color:var(--ink);word-break:break-all">${u.email}${u.email===ADMIN_EMAIL?' <span style="color:var(--gold);font-size:10px">admin</span>':''}</span>
        <select onchange="sbSetAmigo('${esc(u.email)}',this.value)">${opt(cur)}</select>
      </div>`;
    }).join('')||'<div class="note">Sem contas aprovadas.</div>';
    elC.innerHTML=CONJUGES.length?CONJUGES.map(c=>`
      <div class="lig-row sf">
        <span style="flex:1;font-size:12.5px;color:var(--ink)">💞 ${c.amigo_a} ↔ ${c.amigo_b}</span>
        <button class="card-act del" title="Separar" onclick="sbDelConjuge('${esc(c.amigo_a)}','${esc(c.amigo_b)}')">✕</button>
      </div>`).join(''):'<div class="note">Sem casais definidos.</div>';
    const sa=document.getElementById('adm-casal-a'),sb2=document.getElementById('adm-casal-b');
    if(sa&&sb2){
      const o=names.map(n=>`<option value="${n}">${n}</option>`).join('');
      sa.innerHTML=o;sb2.innerHTML=o;
    }
  }catch(e){
    elL.innerHTML='<div class="note">Erro a carregar ('+e.message+'). Já correste o script 03 no Supabase?</div>';
    elC.innerHTML='';
  }
}

async function sbSetAmigo(email,amigo){
  try{
    if(!amigo)await sbReq('DELETE',`user_amigos?email=eq.${enc(email)}`);
    else await sbReq('POST','user_amigos?on_conflict=email',[{email,amigo}],{Prefer:'resolution=merge-duplicates'});
    toast('Ligação atualizada ✓','ok');
    sbRenderLigacoes();
  }catch(e){toast('Erro: '+e.message,'bad');}
}

async function sbAddConjuge(){
  const a=document.getElementById('adm-casal-a').value;
  const b=document.getElementById('adm-casal-b').value;
  if(!a||!b||a===b){toast('Escolhe duas pessoas diferentes','bad');return;}
  if(CONJUGES.some(c=>(c.amigo_a===a&&c.amigo_b===b)||(c.amigo_a===b&&c.amigo_b===a))){toast('Esse casal já está ligado','bad');return;}
  try{
    await sbReq('POST','conjuges',[{amigo_a:a,amigo_b:b}]);
    toast('Casal ligado ✓','ok');
    sbRenderLigacoes();
  }catch(e){toast('Erro: '+e.message,'bad');}
}

async function sbDelConjuge(a,b){
  if(!confirm(`Separar ${a} ↔ ${b}?`))return;
  try{
    await sbReq('DELETE',`conjuges?amigo_a=eq.${enc(a)}&amigo_b=eq.${enc(b)}`);
    toast('Casal removido','ok');
    sbRenderLigacoes();
  }catch(e){toast('Erro: '+e.message,'bad');}
}

/* GO */
sbInit();
document.addEventListener('visibilitychange',async()=>{if(!document.hidden&&_sbSession&&!_writeBusy){await sbEnsureFresh();carregar();}});
// Ao ir para segundo plano / fechar: fecha já os logs de presença pendentes
// (caso a pessoa marque algo e saia antes do debounce de 1.2s disparar).
document.addEventListener('visibilitychange',()=>{if(document.hidden){try{flushPresLogs();}catch(_){}}});
window.addEventListener('pagehide',()=>{try{flushPresLogs();}catch(_){}});
document.getElementById('admin-bg').addEventListener('click',e=>{if(e.target.id==='admin-bg')closeAdmin();});
document.getElementById('pay-bg').addEventListener('click',e=>{if(e.target.id==='pay-bg')closePayModal();});
document.getElementById('edit-cf-bg').addEventListener('click',e=>{if(e.target.id==='edit-cf-bg')closeEditCf();});
document.getElementById('refdef-bg').addEventListener('click',e=>{if(e.target.id==='refdef-bg')closeRefdefModal();});
document.getElementById('shop-item-bg').addEventListener('click',e=>{if(e.target.id==='shop-item-bg')closeShopItemModal();});
document.getElementById('shop-buy-bg').addEventListener('click',e=>{if(e.target.id==='shop-buy-bg')closeShopBuyModal();});
