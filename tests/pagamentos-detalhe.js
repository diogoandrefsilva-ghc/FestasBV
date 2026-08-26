/* Regressão (26/08/2026): a ficha do membro (openMember) resumia TODOS os
   pagamentos que saldaram a dívida de alguém numa única linha por "quem
   pagou" — mesmo quando havia vários, de origens e datas diferentes (um
   adiantamento livre antes do fecho, um 🤝 mais tarde só de parte da dívida
   de convidados, um pago pelo cônjuge…). Passa a detalhar pagamento a
   pagamento (data + quem + o que saldou) sempre que há mais do que um;
   com um só, mantém-se a linha única de sempre — não há nada a detalhar
   num pagamento sozinho.

   Este teste fabrica CALC/DATA ao nível que openMember() realmente consome
   (membros já calculados + pagamentos já com `p._alloc`, o que o calcular()
   escreve — ver a nota "O que ESTE pagamento saldou" antes do loop de
   credited/creditedConv), em vez de correr o calcular() inteiro: é o mesmo
   estilo dos outros testes (fixture ao nível da função, não do evento todo).

   Correr: node tests/pagamentos-detalhe.js */
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const appPath=process.argv[2]||'/home/user/FestasBV/app.js';
const noop=()=>{};
const captured={};
function fakeEl(id){
  const o={_html:'',classList:{add:noop,remove:noop,toggle:noop,contains:()=>false},style:new Proxy({},{get:()=>'',set:()=>true})};
  Object.defineProperty(o,'innerHTML',{get:()=>o._html,set:v=>{o._html=v;captured[id]=v;}});
  return o;
}
const ids=['sheet-hdr','sheet-in','sheet-bg','sheet'];
const elems={};ids.forEach(id=>elems[id]=fakeEl(id));
const doc={getElementById:id=>elems[id]||null,querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>fakeEl('_'),body:fakeEl('body'),documentElement:fakeEl('html'),addEventListener:noop,head:fakeEl('head'),readyState:'complete'};
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

// `DATA`/`CALC` são `let` no topo do app.js — ligam-se por script no MESMO
// contexto (o mesmo truque das sondas em pagamentos-lote.js e do CALC em
// dividas-em-aberto.js), não por `ctx.DATA=`.
function setState(calc,data){ctx.__CALC_TMP__=calc;ctx.__DATA_TMP__=data;vm.runInContext('CALC=__CALC_TMP__;DATA=__DATA_TMP__;',ctx);}

const baseMembro=(nome)=>({
  nome, sexo:'M', Sown:0,AA:0,TS:0,SS:0,DescM:0,RB:0,W:0,X:0,Y:0,V:0,Z:0,AC:0,U:0,R:0,
  fator:1, saldoFinal:0, _refs:[],_convs:[],_tshirts:[],_stockSobra:[],
  _payerOwnPortion:0,_creditedBy:[],_ownCredit:0,_convCredit:0,
});

// ── Caso 1: TRÊS pagamentos a saldar a dívida do João Paulo — um do
//    cônjuge (Pedro Caseiro, um 🤝 pela dívida própria dele, antes do fecho
//    de contas), um adiantamento livre do próprio, e agora um 🤝 parcial da
//    dívida de convidados dele ──
{
  const joaoPaulo=Object.assign(baseMembro('João Paulo'),{_payerOwnPortion:43,_creditedBy:[{payer:'Pedro Caseiro',amount:20,type:'own'}]});
  const pedro=baseMembro('Pedro Caseiro');
  const pagamentos=[
    {de:'Pedro Caseiro',para:'Diogo',valor:20,ref:'own:João Paulo',data:'2026-08-10',_alloc:[{nome:'João Paulo',tipo:'own',valor:20}]},
    {de:'João Paulo',para:'Diogo',valor:10,ref:'',data:'2026-08-15',_alloc:[{nome:'João Paulo',tipo:'adiant',valor:10}]},
    {de:'João Paulo',para:'Diogo',valor:33,ref:'conv:João Paulo',data:'2026-08-24',_alloc:[{nome:'João Paulo',tipo:'conv',valor:33}]},
  ];
  setState({membros:[joaoPaulo,pedro],pagamentos},{evento:{tesoureiro:'Diogo'},despesas:[]});
  ctx.openMember('João Paulo');
  const html=captured['sheet-in'];
  assert.ok(html,'a ficha tem de escrever alguma coisa');
  assert.ok(/Pagamentos para saldar \(3\)/.test(html),
    `FALHA: com 3 pagamentos a saldar devia aparecer o bloco detalhado — veio:\n${html}`);
  assert.ok(/Dívida de convidados/.test(html),'devia identificar a parcela de convidados');
  assert.ok(/Adiantamento/.test(html),'devia identificar o adiantamento livre');
  assert.ok(/Dívida própria/.test(html),'devia identificar a parcela de dívida própria');
  assert.ok(/Pago por Pedro Caseiro/.test(html),'devia dizer quem pagou por ele');
  assert.ok(/Pagaste/.test(html),'devia dizer que ele próprio pagou a outra parte');
  assert.ok(/63,00\s*€|63,00€/.test(html.replace(/&nbsp;/g,' ')),
    `FALHA: o total do bloco tinha de ser 63,00€ (20+10+33) — veio:\n${html}`);
}

// ── Caso 2: UM pagamento só — mantém-se a linha única de sempre, sem o
//    bloco detalhado (nada a detalhar) ──
{
  const rita=Object.assign(baseMembro('Rita'),{_payerOwnPortion:0,_creditedBy:[{payer:'Samuel',amount:15,type:'own'}]});
  const samuel=baseMembro('Samuel');
  const pagamentos=[
    {de:'Samuel',para:'Diogo',valor:15,ref:'own:Rita',data:'2026-08-20',_alloc:[{nome:'Rita',tipo:'own',valor:15}]},
  ];
  setState({membros:[rita,samuel],pagamentos},{evento:{tesoureiro:'Diogo'},despesas:[]});
  ctx.openMember('Rita');
  const html=captured['sheet-in'];
  assert.ok(!/Pagamentos para saldar/.test(html),'FALHA: com 1 pagamento só não devia haver bloco detalhado');
  assert.ok(/Pago por Samuel/.test(html),'devia manter a linha única "Pago por Samuel"');
}

// ── Caso 3: formato ANTIGO (tipo '?', sem prefixo own:/conv:) fica de fora
//    da nova lista — nunca alimentou _payerOwnPortion/_creditedBy, e incluí-lo
//    desalinhava este total do "Créditos" do Saldo Final ──
{
  const ze=Object.assign(baseMembro('Zé'),{_payerOwnPortion:0,_creditedBy:[]});
  const pagamentos=[
    {de:'Outro',para:'Diogo',valor:10,ref:'Zé',data:'2026-08-05',_alloc:[{nome:'Zé',tipo:'?',valor:10}]},
  ];
  setState({membros:[ze],pagamentos},{evento:{tesoureiro:'Diogo'},despesas:[]});
  ctx.openMember('Zé');
  const html=captured['sheet-in'];
  assert.ok(!/Pagamentos para saldar/.test(html)&&!/Pago por Outro/.test(html),
    `FALHA: formato antigo não devia aparecer nesta lista nova — veio:\n${html}`);
}

console.log('OK — a ficha do membro detalha pagamento a pagamento quando há vários, e mantém a linha única com um só');
process.exit(0); // sbInit() fica agendado no fim do app.js e rebenta contra o DOM falso — sai já
