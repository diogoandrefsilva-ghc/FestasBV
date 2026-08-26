/* Regressão de `_dividasEmAberto` — a repartição da dívida de alguém em
   "própria" e "de convidados" para as chips de 🤝 Pagar Dívida.

   Duas versões mais simples já passaram por aqui, e as duas descartavam
   excedente de crédito em vez de o transportar entre categorias:

   1) (até 26/08/2026) só descontava adiantamentos livres (pagamentos sem
      `ref`) — nunca os 🤝 já direcionados a own:/conv: de uma dívida
      específica. Pagar PARTE da dívida de convidados não descia o valor
      proposto da vez seguinte.
   2) (26/08/2026, correção do dia) passou a descontar os 🤝 diretos
      (`m._ownCredit`/`m._convCredit`) mas continuava a ignorar o excedente
      de DESPESAS ADIANTADAS: alguém que adianta despesas do grupo em mais
      do que a própria dívida ficava com a chip de convidados presa a um
      valor mais alto do que o que falta mesmo (121 vs. os 112 reais).

   A versão de agora deriva TUDO do `saldoEcra(m)` — o mesmo número que os
   Saldos mostram — e só decide a REPARTIÇÃO entre categorias. Este teste
   corre o `saldoMovimentos` A SÉRIO (não fabrica o saldo à mão), para
   apanhar exatamente este tipo de discrepância entre o total e a chip.

   Correr: node tests/dividas-em-aberto.js */
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
  alert:noop,confirm:()=>false,prompt:()=>null,matchMedia:()=>({matches:false,addEventListener:noop}),
  crypto:{randomUUID:()=>'x'},Intl,URL,URLSearchParams,btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary')};
ctx.window=ctx;ctx.globalThis=ctx;ctx.self=ctx;
vm.createContext(ctx);
try{vm.runInContext(fs.readFileSync(appPath,'utf8'),ctx,{filename:appPath});}catch(e){}

// `CALC`/`DATA` são `let` no topo do app.js — ligam-se por script no MESMO
// contexto (o mesmo truque das sondas em pagamentos-lote.js), não por `ctx.*=`.
function setState(membros,pagamentos,despesas,mealheiros){
  ctx.__CALC_TMP__={membros,pagamentos,saldoGrupo:0};
  ctx.__DATA_TMP__={evento:{tesoureiro:'Diogo'},despesas:despesas||[],mealheiros:mealheiros||[]};
  vm.runInContext('CALC=__CALC_TMP__;DATA=__DATA_TMP__;',ctx);
}
const baseMembro=(nome)=>({nome,Sown:0,AA:0,TS:0,SS:0,R:0,U:0,W:0,X:0,
  _payerOwnPortion:0,_creditedBy:[],_convCredit:0,_sfEcra:NaN /* decoi: se saldoEcra cair no fallback, o teste falha com NaN em vez de mascarar o bug */});

// ── Cenário A (o bug de agora, 26/08/2026): João Paulo tem 154€ de dívida
//    de convidados EM BRUTO, já pagou 33€ dela por 🤝 (own-portion 33), E
//    adiantou 29€ de despesas do grupo contra 20€ de dívida própria — um
//    excedente de 9€ que tem de abater à de convidados. Total real: 112€. ──
{
  const jp=Object.assign(baseMembro('João Paulo'),{Sown:20,AA:154,_payerOwnPortion:33,_convCredit:33});
  setState([jp],[{de:'João Paulo',para:'Diogo',valor:33,ref:'conv:João Paulo',data:'2026-08-24'}],
    [{quem:'João Paulo',valor:29,dataDesp:'2026-08-01'}]);
  const d=ctx._dividasEmAberto(jp);
  assert.strictEqual(ctx.saldoEcra(jp),-112,`FALHA: saldoEcra devia dar -112 — veio ${ctx.saldoEcra(jp)}`);
  assert.strictEqual(d.conv,112,
    `FALHA: a chip de convidados tinha de descer para 112 com o excedente das despesas adiantadas — veio ${d.conv}`);
  assert.strictEqual(d.prop,0,`FALHA: sem dívida própria por saldar, prop devia ser 0 — veio ${d.prop}`);
  assert.strictEqual(rnd2(d.prop+d.conv),112,'a soma das duas categorias tem de ser sempre o total devido');
}

// ── Cenário B: sem despesas adiantadas, só o 🤝 parcial de convidados —
//    tem de continuar a funcionar como antes (o bug já corrigido no
//    mesmo dia) ──
{
  const jp=Object.assign(baseMembro('João Paulo'),{Sown:0,AA:154,_payerOwnPortion:33,_convCredit:33});
  setState([jp],[],[]);
  const d=ctx._dividasEmAberto(jp);
  assert.strictEqual(d.conv,121,`FALHA: sem excedente de despesas, a chip é só 154−33=121 — veio ${d.conv}`);
  assert.strictEqual(d.prop,0);
}

// ── Cenário C: dívida PRÓPRIA com 🤝 parcial (sem convidados) — mesma
//    regra do lado 'own' ──
{
  const rita=Object.assign(baseMembro('Rita'),{Sown:200,AA:0,_payerOwnPortion:50});
  setState([rita],[],[]);
  const d=ctx._dividasEmAberto(rita);
  assert.strictEqual(d.prop,150,`FALHA: a dívida própria devia descer para 150 (200−50 já pago por 🤝) — veio ${d.prop}`);
  assert.strictEqual(d.conv,0);
}

// ── Cenário D: tudo saldado — as duas categorias ficam a 0, não negativas ──
{
  const ze=Object.assign(baseMembro('Zé'),{Sown:80,AA:0,_payerOwnPortion:80});
  setState([ze],[],[]);
  const d=ctx._dividasEmAberto(ze);
  assert.strictEqual(d.prop,0);assert.strictEqual(d.conv,0);
}

function rnd2(n){return Math.round(n*100)/100;}
console.log('OK — _dividasEmAberto deriva-se do saldoEcra e nunca discorda do total devido');
process.exit(0); // sbInit() fica agendado no fim do app.js e rebenta contra o DOM falso — sai já
