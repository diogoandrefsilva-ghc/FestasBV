/* Regressão da FASE DO ANO (db/fase_ano.sql).

   Duas coisas que não podem partir-se, e que não se veem a olho:

   1) OS PREDICADOS DE SEMPRE derivam da fase — contasFechadas() é "chegou a
      val_contas" e pagamentosAutorizados() é "chegou a pagamento". São
      dezenas de sítios que os perguntam sem saberem que a fase existe; se a
      derivação escorregar um passo, o ano tranca (ou destranca) sozinho.
      Inclui o caso SEM MIGRAÇÃO, em que a fase se lê dos dois booleanos.

   2) O PATCH do setFase só carimba o booleano que MUDA. Recuar de 'fechado'
      para 'pagamento' não pode reescrever a hora a que as contas fecharam —
      e não muda booleano nenhum, logo não pode mandar nenhum.

   Correr: node tests/fase-ano.js */
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const appPath=process.argv[2]||'/home/user/FestasBV/app.js';
const noop=()=>{};
const el=new Proxy({},{get:(t,k)=>{
  if(k==='style')return new Proxy({},{get:()=>'',set:()=>true});
  if(k==='classList')return{add:noop,remove:noop,toggle:noop,contains:()=>false};
  if(k==='value'||k==='innerHTML'||k==='textContent')return'';
  if(['appendChild','addEventListener','remove','setAttribute'].includes(k))return noop;
  if(k==='querySelectorAll')return()=>[];
  if(k==='querySelector')return()=>null;
  return undefined;},set:()=>true});
const doc={getElementById:()=>null,querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>el,body:el,documentElement:el,addEventListener:noop,head:el,readyState:'complete'};
const store={};const ls={getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v);},removeItem:k=>{delete store[k];}};
const ctx={console,setTimeout,clearTimeout,setInterval,clearInterval,JSON,Math,Date,Number,String,Object,Array,Boolean,RegExp,Error,Map,Set,Promise,parseInt,parseFloat,isNaN,isFinite,encodeURIComponent,decodeURIComponent,
  document:doc,localStorage:ls,sessionStorage:ls,fetch:()=>Promise.resolve({ok:false,json:()=>Promise.resolve([])}),
  location:{href:'',search:'',hash:'',hostname:'localhost',pathname:'/',origin:'http://localhost',reload:noop},
  navigator:{userAgent:'node',serviceWorker:{register:()=>Promise.resolve(),ready:Promise.resolve({})},onLine:true},
  alert:noop,confirm:()=>true,prompt:()=>null,matchMedia:()=>({matches:false,addEventListener:noop}),
  crypto:{randomUUID:()=>'x'},Intl,URL,URLSearchParams,btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary')};
ctx.window=ctx;ctx.globalThis=ctx;ctx.self=ctx;
vm.createContext(ctx);
try{vm.runInContext(fs.readFileSync(appPath,'utf8'),ctx,{filename:appPath});}catch(e){}

/* DATA e _sbSession são `let` no topo do app.js: vivem no escopo lexical do
   script, não em ctx.* — um `ctx.DATA=…` criava uma variável à parte, que as
   funções não leem (é a mesma nota que o teste dos pagamentos deixa sobre as
   sondas de coluna). Escreve-se por script, no MESMO contexto. */
const evt=o=>{ctx.__d={_sbId:7,evento:Object.assign({ano:2026},o)};vm.runInContext('DATA=__d;',ctx);};
vm.runInContext('_sbSession={user:{email:"admin@x.pt"}};',ctx);

// ── 1) A fase manda nos dois predicados ──────────────────────────────────
const esperado={
  aberto:        {fech:false,aut:false,tranc:false},
  val_presencas: {fech:false,aut:false,tranc:false},
  val_contas:    {fech:true, aut:false,tranc:false},
  pagamento:     {fech:true, aut:true, tranc:false},
  fechado:       {fech:true, aut:true, tranc:true }
};
Object.keys(esperado).forEach(k=>{
  // Booleanos a false de propósito: quem tem de mandar aqui é a fase
  evt({fase:k,faseCol:true,contasFechadas:false,pagamentosAutorizados:false});
  const e=esperado[k];
  assert.strictEqual(ctx.faseDoAno(),k,'faseDoAno '+k);
  assert.strictEqual(ctx.contasFechadas(),e.fech,'contasFechadas em '+k);
  assert.strictEqual(ctx.pagamentosAutorizados(),e.aut,'pagamentosAutorizados em '+k);
  assert.strictEqual(ctx.pagamentosTrancados(),e.tranc,'pagamentosTrancados em '+k);
});
// Um valor que a app não conhece cai no fallback dos booleanos — nunca rebenta
evt({fase:'chico-esperto',faseCol:true,contasFechadas:true,pagamentosAutorizados:false});
assert.strictEqual(ctx.faseDoAno(),'val_contas','fase desconhecida → fallback');

// ── 2) SEM a migração: o comportamento é exatamente o de antes ────────────
[[false,false,'aberto'],[true,false,'val_contas'],[true,true,'pagamento']].forEach(([cf,pa,k])=>{
  evt({faseCol:false,contasFechadas:cf,pagamentosAutorizados:pa});
  assert.strictEqual(ctx.faseDoAno(),k,'sem coluna: '+cf+'/'+pa);
  assert.strictEqual(ctx.contasFechadas(),cf,'sem coluna, contasFechadas');
  assert.strictEqual(ctx.pagamentosAutorizados(),pa,'sem coluna, pagamentosAutorizados');
  assert.strictEqual(ctx.pagamentosTrancados(),false,'sem coluna nunca tranca pagamentos');
});
// A coluna existir mas a linha estar vazia é o mesmo caso (antes do backfill)
evt({fase:null,faseCol:true,contasFechadas:true,pagamentosAutorizados:true});
assert.strictEqual(ctx.faseDoAno(),'pagamento','fase vazia → fallback');

// ── 3) O PATCH do setFase ─────────────────────────────────────────────────
const patches=[];
ctx.sbReq=async(method,path,body)=>{patches.push({method,path,body});return null;};
ctx.queueWrite=fn=>fn();
ctx.setSync=noop;ctx.marcaGuardado=noop;ctx.renderAll=noop;ctx.toast=noop;ctx.syncMirror=noop;
ctx.avisarFase=noop;ctx.isAdmin=()=>true;ctx.anoCorrente=()=>false;
// Sem despesas provisórias e com a última refeição já passada — as condições
// que travam a entrada em val_contas testam-se à parte (faseMotivoAvancar)
ctx.temDespesasPendentes=()=>false;
ctx.ultimaRefeicaoISO=()=>'2020-01-01';

async function corre(de,para){
  patches.length=0;
  evt({fase:de,faseCol:true,pagAutorizCol:true,
    contasFechadas:['val_contas','pagamento','fechado'].includes(de),
    pagamentosAutorizados:['pagamento','fechado'].includes(de)});
  await ctx.setFase(para);
  return patches[0]&&patches[0].body;
}
(async()=>{
  // aberto → val_presencas: nenhum booleano muda, logo nenhum é carimbado
  let b=await corre('aberto','val_presencas');
  assert.ok(b,'val_presencas gravou');
  assert.strictEqual(b.fase,'val_presencas');
  assert.ok(!('contas_fechadas' in b)&&!('pagamentos_autorizados' in b),'val_presencas não toca nos booleanos');

  // val_presencas → val_contas: fecha as contas (e só isso)
  b=await corre('val_presencas','val_contas');
  assert.strictEqual(b.contas_fechadas,true,'val_contas fecha');
  assert.ok(b.contas_fechadas_em,'val_contas carimba');
  assert.ok(!('pagamentos_autorizados' in b),'val_contas não autoriza pagamentos');

  // val_contas → pagamento: autoriza, e NÃO reescreve o carimbo do fecho
  b=await corre('val_contas','pagamento');
  assert.strictEqual(b.pagamentos_autorizados,true,'pagamento autoriza');
  assert.ok(!('contas_fechadas' in b),'pagamento não recarimba o fecho');

  // pagamento → fechado: os dois booleanos já estão a true, nada muda
  b=await corre('pagamento','fechado');
  assert.strictEqual(b.fase,'fechado');
  assert.ok(!('contas_fechadas' in b)&&!('pagamentos_autorizados' in b),'fechado não recarimba nada');

  // fechado → pagamento (recuar): idem — a hora do fecho fica intacta
  b=await corre('fechado','pagamento');
  assert.strictEqual(b.fase,'pagamento');
  assert.ok(!('contas_fechadas_em' in b),'recuar não reescreve a hora do fecho');

  // pagamento → val_contas (recuar): retira a autorização, mantém o fecho
  b=await corre('pagamento','val_contas');
  assert.strictEqual(b.pagamentos_autorizados,false,'recuar retira a autorização');
  assert.strictEqual(b.pagamentos_autorizados_em,null);
  assert.ok(!('contas_fechadas' in b),'recuar para val_contas mantém as contas fechadas');

  // Saltar fases não grava nada — cada passo tem o seu aviso e a sua pergunta
  assert.strictEqual(await corre('aberto','pagamento'),undefined,'não salta fases');
  assert.strictEqual(await corre('aberto','aberto'),undefined,'ficar na mesma não grava');

  // ── Sem db/fase_ano.sql o slider CONTINUA A FUNCIONAR, com três fases ──
  // (fechar as contas era coisa que o admin sempre pôde fazer; trancar-lhe o
  // slider por falta de uma migração tirava-lhe isso.) O ‹ › salta as duas
  // fases que os booleanos não sabem guardar, e a coluna nunca é escrita.
  patches.length=0;
  evt({fase:null,faseCol:false,pagAutorizCol:true,contasFechadas:false,pagamentosAutorizados:false});
  assert.strictEqual(ctx.faseVizinha(1),'val_contas','sem migração, aberto → val_contas');
  assert.strictEqual(ctx.faseVizinha(-1),null,'sem migração, aberto não recua');
  await ctx.setFase('val_presencas');
  assert.strictEqual(patches.length,0,'sem migração não se grava val_presencas');
  await ctx.setFase('val_contas');
  assert.strictEqual(patches.length,1,'sem migração fecha as contas à mesma');
  assert.ok(!('fase' in patches[0].body),'sem migração não escreve a coluna fase');
  assert.strictEqual(patches[0].body.contas_fechadas,true);
  // E na última fase que os booleanos sabem dizer, não há para onde ir
  evt({fase:null,faseCol:false,pagAutorizCol:true,contasFechadas:true,pagamentosAutorizados:true});
  assert.strictEqual(ctx.faseVizinha(1),null,'sem migração não há Ano Fechado');
  assert.ok(/fase_ano/.test(ctx.faseMotivoAvancar()||''),'e o motivo diz porquê');

  // ── 4) O que trava o avanço ────────────────────────────────────────────
  evt({fase:'val_presencas',faseCol:true,pagAutorizCol:true,contasFechadas:false,pagamentosAutorizados:false});
  ctx.temDespesasPendentes=()=>true;
  assert.ok(/provisórias/.test(ctx.faseMotivoAvancar()||''),'provisórias travam o val_contas');
  ctx.temDespesasPendentes=()=>false;
  assert.strictEqual(ctx.faseMotivoAvancar(),null,'sem provisórias, avança');
  // Uma provisória NÃO trava as fases que não fecham as contas
  evt({fase:'aberto',faseCol:true,pagAutorizCol:true,contasFechadas:false,pagamentosAutorizados:false});
  ctx.temDespesasPendentes=()=>true;
  assert.strictEqual(ctx.faseMotivoAvancar(),null,'provisórias não travam o val_presencas');
  ctx.temDespesasPendentes=()=>false;
  // A última fase não tem para onde ir
  evt({fase:'fechado',faseCol:true,pagAutorizCol:true,contasFechadas:true,pagamentosAutorizados:true});
  assert.ok(ctx.faseMotivoAvancar(),'a última fase não avança');

  console.log('fase-ano: OK');
  // O arranque da app (sbInit) fica agendado no contexto e rebenta contra o
  // DOM falso mal o event loop lhe chegue — este teste é assíncrono, logo
  // sai já em vez de esperar por ele.
  process.exit(0);
})().catch(e=>{console.error('fase-ano: FALHOU —',e.message);process.exit(1);});
