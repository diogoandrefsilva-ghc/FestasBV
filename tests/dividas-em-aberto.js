/* Regressão (26/08/2026): pagar PARTE da dívida de convidados/própria por 🤝
   (ref `own:`/`conv:`) tinha de descer o valor que a app volta a propor na
   chip dessa categoria — `_dividasEmAberto` só descontava adiantamentos
   livres (pagamentos sem `ref`), nunca os 🤝 já direcionados a uma dívida
   específica. O saldo total (`m.saldoFinal`) já descia certo; só a chip por
   categoria é que ficava presa ao valor em BRUTO, como se o pagamento
   anterior não tivesse existido. Ver a nota no CLAUDE.md. */
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

// `CALC` é `let` no topo do app.js: vive no escopo lexical do contexto, por
// isso liga-se por script NO MESMO contexto (`vm.runInContext`), não por
// `ctx.CALC=`, que criaria só uma propriedade solta sem relação com o `CALC`
// que as funções do script veem (o mesmo truque das sondas em pagamentos-lote.js).
function setCalc(calc){ctx.__CALC_TMP__=calc;vm.runInContext('CALC=__CALC_TMP__;',ctx);}

// João: dívida própria já zerada (adiantou despesas dele), dívida de
// convidados em bruto = 145. calcular() já teria posto _convCredit=33 pelo
// 🤝 anterior (ref 'conv:João', 33€) — é isso que _dividasEmAberto tem de ler.
const joao={nome:'João', V:100,Y:0,W:0,X:100, AA:145, _ownCredit:0, _convCredit:33};
setCalc({pagamentos:[],membros:[joao]});

let d=ctx._dividasEmAberto(joao);
assert.strictEqual(d.prop,0,'dívida própria devia estar a 0 (V-Y-W-X)');
assert.strictEqual(d.conv,112,
  `FALHA: a chip de convidados devia descer para 112 (145 − 33 já pago por 🤝) e não ficar presa ao bruto — veio ${d.conv}`);

// Em cima do 🤝 já direcionado, um adiantamento LIVRE (sem ref) de 20€ tem de
// continuar a abater o que sobrar, como sempre abateu.
setCalc({pagamentos:[{de:'João',para:'Diogo',valor:20,ref:'',data:'2026-08-25'}],membros:[joao]});
d=ctx._dividasEmAberto(joao);
assert.strictEqual(d.conv,92,`FALHA: o adiantamento livre tinha de continuar a abater o resto (112−20=92) — veio ${d.conv}`);

// Dívida própria com 🤝 parcial: mesma regra do lado 'own'.
const rita={nome:'Rita', V:200,Y:0,W:0,X:0, AA:0, _ownCredit:50, _convCredit:0};
setCalc({pagamentos:[],membros:[rita]});
d=ctx._dividasEmAberto(rita);
assert.strictEqual(d.prop,150,`FALHA: a dívida própria devia descer para 150 (200−50 já pago por 🤝) — veio ${d.prop}`);
assert.strictEqual(d.conv,0);

console.log('OK — _dividasEmAberto desconta os 🤝 já direcionados (own:/conv:), não só os adiantamentos livres');
process.exit(0); // o app.js agenda o próprio sbInit() no fim do ficheiro; sem sair já, o event loop chega-lhe a vez e rebenta sem DOM
