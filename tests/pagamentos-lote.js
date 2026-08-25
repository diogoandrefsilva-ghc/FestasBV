/* Regressão: o POST em lote de `pagamentos` tem de mandar SEMPRE o mesmo
   conjunto de chaves em todas as linhas. O PostgREST monta uma lista de
   colunas para o lote e preenche a NULL EXPLÍCITO as linhas a que uma chave
   falte (não aplica o DEFAULT) — foi isso que rebentou o INSERT a 25/08/2026
   e, com o DELETE já feito, deixou 2026 sem pagamento nenhum. */
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

// Captura os POSTs em vez de os mandar para a rede
const sent=[];
ctx.sbReq=async(method,path,body)=>{sent.push({method,path,body});
  return Array.isArray(body)?body.map((_,i)=>({id:1000+i})):[{id:1}];};
ctx.setSync=noop;
// As sondas são `let` no topo do app.js: vivem no escopo lexical global do
// contexto, por isso ligam-se por script no MESMO contexto, não por ctx.*
vm.runInContext('PAG_CRIADO_EM_COL=true;PAG_NOTA_COL=true;',ctx);
ctx.ALL_YEARS=[]; ctx.DATA={evento:{ano:2026},_sbId:2};

// O caso real: 2 pagamentos já vindos da BD (com criadoEm) + 1 acabado de
// registar (sem criadoEm) — exatamente a mistura do dia 25/08.
const y={_sbId:2,evento:{nome:'MEO 2026',ano:2026,tesoureiro:'Diogo'},
  membros:[],refeicoesDef:[],despesas:[],convidados:[],mealheiros:[],
  pagamentos:[
    {de:'Samuel',para:'Diogo',valor:372,ref:'own:Samuel',data:'2026-08-25',extra:0,nota:'',criadoEm:'2026-08-25T08:24:54.157+00:00'},
    {de:'João Hélder',para:'Diogo',valor:89,ref:'own:João Hélder',data:'2026-08-25',extra:0,nota:'',criadoEm:'2026-08-25T08:24:54.157+00:00'},
    {de:'Rita',para:'Diogo',valor:143,ref:'own:Rita',data:'2026-08-25',extra:0,nota:''}   // NOVO
  ]};

(async()=>{
  await ctx.sbGuardarEvento(y,0);
  const post=sent.find(s=>s.method==='POST'&&s.path==='pagamentos');
  assert(post,'não houve POST de pagamentos');
  const rows=post.body;
  assert.strictEqual(rows.length,3,'devia mandar as 3 linhas');

  const keys=rows.map(r=>Object.keys(r).sort().join(','));
  console.log('chaves por linha:');rows.forEach((r,i)=>console.log('  '+i+': '+keys[i]));
  assert.strictEqual(new Set(keys).size,1,
    'FALHA: as linhas do lote não têm todas as mesmas chaves — o PostgREST poria NULL nas que faltam');

  rows.forEach((r,i)=>assert(r.criado_em,'FALHA: linha '+i+' sem criado_em (viraria NULL e rebentava o NOT NULL)'));
  assert.strictEqual(rows[0].criado_em,'2026-08-25T08:24:54.157+00:00','o pagamento antigo tem de manter a hora original');
  assert.strictEqual(rows[1].criado_em,'2026-08-25T08:24:54.157+00:00','o pagamento antigo tem de manter a hora original');
  assert(rows[2].criado_em&&rows[2].criado_em!==rows[0].criado_em,'o pagamento novo tem de ganhar hora própria');
  console.log('\nOK — lote homogéneo, criado_em preservado nos antigos e atribuído ao novo');process.exit(0);
})().catch(e=>{console.error('\n'+e.message);process.exit(1);});
