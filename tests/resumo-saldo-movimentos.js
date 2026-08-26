/* Regressão (26/08/2026): o cartão "Resumo fundido nos Saldos" (a lista de
   membros, ANTES de se abrir a ficha) mostra os movimentos de cada um via
   `saldoMovimentos(m).mv` — e "Pagou para saldar"/"Pago por X" eram somas
   sem detalhe nenhum, ao contrário das linhas vizinhas do mesmo cartão
   ("Despesas adiantadas", "Mealheiro recebido"), que já abrem com a seta ▼
   e mostram cada entrada por si. Um adiantamento livre de 20€ e um 🤝
   parcial de 33€ apareciam somados numa linha só, "Pagou para saldar:
   53,00€", sem se ver que eram dois pagamentos diferentes.

   `mv.ownPortionL`/`mv.paidByL` passam a existir, lidas do MESMO `p._alloc`
   que a ficha do membro (openMember, ver tests/pagamentos-detalhe.js) já
   usa — não é uma segunda leitura a poder discordar da primeira.

   Correr: node tests/resumo-saldo-movimentos.js */
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
// contexto (o mesmo truque das sondas em pagamentos-lote.js).
function setState(membros,pagamentos,despesas,mealheiros){
  ctx.__CALC_TMP__={membros,pagamentos,saldoGrupo:0};
  ctx.__DATA_TMP__={evento:{tesoureiro:'Diogo'},despesas:despesas||[],mealheiros:mealheiros||[]};
  vm.runInContext('CALC=__CALC_TMP__;DATA=__DATA_TMP__;',ctx);
}
const baseMembro=(nome)=>({nome,Sown:0,AA:0,TS:0,SS:0,R:0,U:0,W:0,X:0,
  _payerOwnPortion:0,_creditedBy:[],_convCredit:0});

// ── Caso do print: João Paulo fez um adiantamento de 20€ e um pagamento
//    parcial de 33€ (ambos dele próprio) — "Pagou para saldar" tinha de
//    detalhar os dois, não só somar 53€ ──
{
  const jp=Object.assign(baseMembro('João Paulo'),{Sown:20,AA:0,_payerOwnPortion:53});
  const pagamentos=[
    {de:'João Paulo',para:'Diogo',valor:20,ref:'',data:'2026-08-15',_alloc:[{nome:'João Paulo',tipo:'adiant',valor:20}]},
    {de:'João Paulo',para:'Diogo',valor:33,ref:'conv:João Paulo',data:'2026-08-24',_alloc:[{nome:'João Paulo',tipo:'conv',valor:33}]},
  ];
  setState([jp],pagamentos,[]);
  const {mv}=ctx.saldoMovimentos(jp);
  assert.strictEqual(mv.ownPortion,53,`FALHA: ownPortion devia ser 53 — veio ${mv.ownPortion}`);
  assert.strictEqual(mv.ownPortionL.length,2,
    `FALHA: "Pagou para saldar" tinha de detalhar os 2 pagamentos — veio ${JSON.stringify(mv.ownPortionL)}`);
  const soma=Math.round(mv.ownPortionL.reduce((a,x)=>a+x.v,0)*100)/100;
  assert.strictEqual(soma,53,'a soma das sub-linhas tem de bater com o total');
  assert.ok(mv.ownPortionL.some(x=>/Adiantamento/.test(x.k)),'uma sub-linha tem de dizer "Adiantamento"');
  assert.ok(mv.ownPortionL.some(x=>/Dívida de convidados/.test(x.k)),'a outra tem de dizer "Dívida de convidados"');
}

// ── "Pago por X" também detalha quando o MESMO pagador contribuiu mais do
//    que uma vez (ex.: o cônjuge, em dois momentos diferentes) ──
{
  const jp=Object.assign(baseMembro('João Paulo'),{Sown:100,AA:0,_payerOwnPortion:0,
    _creditedBy:[{payer:'Pedro Caseiro',amount:20,type:'own'},{payer:'Pedro Caseiro',amount:15,type:'own'}]});
  const pagamentos=[
    {de:'Pedro Caseiro',para:'Diogo',valor:20,ref:'own:João Paulo',data:'2026-08-10',_alloc:[{nome:'João Paulo',tipo:'own',valor:20}]},
    {de:'Pedro Caseiro',para:'Diogo',valor:15,ref:'own:João Paulo',data:'2026-08-18',_alloc:[{nome:'João Paulo',tipo:'own',valor:15}]},
  ];
  setState([jp],pagamentos,[]);
  const {mv}=ctx.saldoMovimentos(jp);
  assert.strictEqual(mv.paidBy['Pedro Caseiro'],35,`FALHA: paidBy devia somar 35 — veio ${mv.paidBy['Pedro Caseiro']}`);
  assert.strictEqual((mv.paidByL['Pedro Caseiro']||[]).length,2,
    `FALHA: "Pago por Pedro Caseiro" tinha de detalhar os 2 pagamentos — veio ${JSON.stringify(mv.paidByL['Pedro Caseiro'])}`);
}

// ── Formato ANTIGO (tipo '?') fica de fora das sub-linhas, como na ficha —
//    nunca alimentou ownPortion/paidBy, e incluí-lo desalinhava a soma ──
{
  const ze=Object.assign(baseMembro('Zé'),{Sown:50,AA:0,_payerOwnPortion:0,_creditedBy:[]});
  const pagamentos=[{de:'Outro',para:'Diogo',valor:10,ref:'Zé',data:'2026-08-05',_alloc:[{nome:'Zé',tipo:'?',valor:10}]}];
  setState([ze],pagamentos,[]);
  const {mv}=ctx.saldoMovimentos(ze);
  assert.strictEqual(mv.ownPortionL.length,0);
  // objeto vindo doutro realm (vm) — comparar por chaves, não por deepStrictEqual
  assert.strictEqual(Object.keys(mv.paidByL).length,0,`FALHA: paidByL devia ficar vazio — veio ${JSON.stringify(mv.paidByL)}`);
}

console.log('OK — "Pagou para saldar"/"Pago por X" detalham pagamento a pagamento no Resumo dos Saldos');
process.exit(0); // sbInit() fica agendado no fim do app.js e rebenta contra o DOM falso — sai já
