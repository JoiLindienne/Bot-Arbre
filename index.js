'use strict';

// Empire Tree — données compatibles avec family.json : parent, spouse, generation.
// Importer ce fichier pour les tests ne connecte pas le bot et ne lit pas .env.
const fs = require('node:fs');
const path = require('node:path');

const libre = id => String(id).startsWith('libre_');
const clone = value => JSON.parse(JSON.stringify(value));
function ensure(data, id) {
  if (!data.nodes[id]) data.nodes[id] = { id, type: libre(id) ? 'libre' : 'user', parent: null, spouse: null, generation: null };
  return data.nodes[id];
}
function clean(data) {
  if (!data || !data.nodes || typeof data.nodes !== 'object' || Array.isArray(data.nodes)) throw new Error('Fichier de familles invalide. Restaure une sauvegarde.');
  for (const [id, node] of Object.entries(data.nodes)) {
    if (!node || typeof node !== 'object') throw new Error('Une personne dans le fichier est invalide.');
    node.id = id;
    node.parent = node.parent && data.nodes[node.parent] ? node.parent : null;
    node.spouse = node.spouse && data.nodes[node.spouse] ? node.spouse : null;
    if (node.parent === id || node.spouse === id) throw new Error('Une personne est liée à elle-même dans les données.');
  }
  for (const [id, node] of Object.entries(data.nodes)) {
    if (!node.spouse) continue;
    const other = data.nodes[node.spouse];
    if (other.spouse && other.spouse !== id) throw new Error('Plusieurs conjoints incompatibles dans les données.');
    other.spouse = id;
  }
  return data;
}
function ancestors(data, id) {
  // Les deux membres d'un couple sont parents des enfants rattachés au couple.
  const seen = new Set(), queue = [id];
  for (let i = 0; i < queue.length; i++) {
    const p = data.nodes[queue[i]]?.parent;
    for (const next of [p, data.nodes[p]?.spouse]) {
      if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}
function normalize(data) {
  clean(data);
  const graph = new Map(Object.keys(data.nodes).map(id => [id, []]));
  function edge(a, b, delta) {
    graph.get(a).push([b, delta]); graph.get(b).push([a, -delta]);
  }
  for (const [id, n] of Object.entries(data.nodes)) {
    if (n.parent) edge(n.parent, id, 1);
    if (n.spouse) edge(id, n.spouse, 0);
  }
  const assigned = new Map();
  for (const id of graph.keys()) {
    if (assigned.has(id)) continue;
    assigned.set(id, Number.isFinite(data.nodes[id].generation) ? data.nodes[id].generation : 0);
    const queue = [id];
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      for (const [next, delta] of graph.get(current)) {
        const wanted = assigned.get(current) + delta;
        if (assigned.has(next)) {
          if (assigned.get(next) !== wanted) throw new Error('Lien incompatible avec les générations existantes. Aucun lien modifié.');
        } else { assigned.set(next, wanted); queue.push(next); }
      }
    }
  }
  for (const [id, generation] of assigned) data.nodes[id].generation = generation;
  return data;
}
function newLibre(data) {
  const id = `libre_${require('node:crypto').randomUUID()}`;
  ensure(data, id); return id;
}
function partner(data, a, b) {
  for (const [id, other] of [[a,b], [b,a]]) {
    const old = data.nodes[id].spouse;
    if (old && old !== other) {
      if (!libre(old)) throw new Error('Cette personne a déjà un conjoint.');
      // Une place de conjoint libre est fusionnée sans perdre ses enfants/ancêtres.
      mergePlaceholder(data, old, other);
    }
  }
  data.nodes[a].spouse = b; data.nodes[b].spouse = a;
}
function sameParents(data, a, b) {
  const pa = data.nodes[a].parent, pb = data.nodes[b].parent;
  return Boolean(pa && pb && (pa === pb || data.nodes[pa]?.spouse === pb));
}
function mergePlaceholder(data, oldId, newId) {
  if (oldId === newId) return;
  if (!libre(oldId)) throw new Error('Un parent existant ne peut pas être remplacé.');
  const old = data.nodes[oldId], next = ensure(data, newId);
  if (!old) return;
  for (const field of ['parent', 'spouse']) {
    if (old[field] === newId || next[field] === oldId) throw new Error('Cette fusion créerait une boucle.');
    if (old[field] && next[field] && old[field] !== next[field]) {
      throw new Error('Cette place libre possède des liens incompatibles avec cette famille.');
    }
  }
  next.parent ||= old.parent;
  next.spouse ||= old.spouse;
  for (const n of Object.values(data.nodes)) {
    if (n.parent === oldId) n.parent = newId;
    if (n.spouse === oldId) n.spouse = newId;
  }
  delete data.nodes[oldId];
}
function addParent(data, child, parent) {
  if (child === parent || ancestors(data, parent).has(child)) throw new Error('Ce lien créerait une boucle parent/enfant.');
  if (data.nodes[child].spouse === parent) throw new Error('Un conjoint ne peut pas être un parent.');
  const old = data.nodes[child].parent;
  if (!old) { data.nodes[child].parent = parent; return; }
  if (old === parent || data.nodes[old].spouse === parent) return;
  if (libre(old)) { mergePlaceholder(data, old, parent); return; }
  // Le modèle d'origine représente le deuxième parent par le conjoint du premier.
  partner(data, old, parent);
}
function makeSiblings(data, a, b) {
  if (a === b) throw new Error('Une personne ne peut pas être son propre frère ou sa propre sœur.');
  if (data.nodes[a].spouse === b || ancestors(data,a).has(b) || ancestors(data,b).has(a)) throw new Error('Lien frère/sœur incompatible avec la famille existante.');
  if (sameParents(data,a,b)) return;
  const pa = data.nodes[a].parent, pb = data.nodes[b].parent;
  if (!pa && !pb) { const p = newLibre(data); data.nodes[a].parent = p; data.nodes[b].parent = p; }
  else if (!pa) data.nodes[a].parent = pb;
  else if (!pb) data.nodes[b].parent = pa;
  else if (libre(pa)) mergePlaceholder(data, pa, pb);
  else if (libre(pb)) mergePlaceholder(data, pb, pa);
  else throw new Error('Ces personnes ont déjà des parents différents. Leurs familles sont conservées.');
}
function relate(data, a, b, relation) {
  const draft = clean(clone(data));
  ensure(draft,a); ensure(draft,b);
  if (a === b) throw new Error('Impossible de se lier à soi-même.');
  const related = ancestors(draft,a).has(b) || ancestors(draft,b).has(a);
  switch (relation) {
    case 'enfant': addParent(draft,a,b); break;
    case 'parent': addParent(draft,b,a); break;
    case 'mari_fiancee':
      if (related || sameParents(draft,a,b)) throw new Error('Impossible de marier des frères/sœurs ou des ancêtres/descendants.');
      partner(draft,a,b); break;
    case 'frere_soeur': makeSiblings(draft,a,b); break;
    case 'cousin_cousine': {
      if (related || sameParents(draft,a,b) || draft.nodes[a].spouse === b) throw new Error('Lien cousin incompatible avec la famille existante.');
      const pa = draft.nodes[a].parent || (draft.nodes[a].parent = newLibre(draft));
      const pb = draft.nodes[b].parent || (draft.nodes[b].parent = newLibre(draft));
      makeSiblings(draft,pa,pb); break;
    }
    default: throw new Error('Type de lien inconnu.');
  }
  normalize(draft); // Vérification de TOUTE la famille avant la moindre écriture.
  return draft;
}

function layout(data) {
  normalize(data);
  const units = [], unitOf = new Map();
  for (const id of Object.keys(data.nodes).sort()) {
    if (unitOf.has(id)) continue;
    const spouse = data.nodes[id].spouse;
    const members = spouse ? [id, spouse].sort() : [id];
    const unit = { members, generation: data.nodes[id].generation, parents: new Set(), children: new Set(), x: 0, owned: [] };
    units.push(unit); for (const member of members) unitOf.set(member,unit);
  }
  for (const [id,n] of Object.entries(data.nodes)) {
    if (!n.parent) continue;
    const a = unitOf.get(n.parent), b = unitOf.get(id);
    a.children.add(b); b.parents.add(a);
  }
  // Chaque couple est placé une seule fois. Une seconde ascendance reste un lien
  // réel, mais ne réserve pas une deuxième copie du même sous-arbre.
  for (const u of units) {
    u.primary = [...u.parents].sort((a,b) => b.children.size-a.children.size || a.members[0].localeCompare(b.members[0]))[0] || null;
    if (u.primary) u.primary.owned.push(u);
  }
  const memberOffset = (unit,id) => (unit.members.indexOf(id)-(unit.members.length-1)/2)*240;
  const anchorOffset = (parent,child) => {
    const targets=child.members.filter(id=>parent.members.includes(data.nodes[id].parent));
    return targets.reduce((sum,id)=>sum+memberOffset(child,id),0)/targets.length;
  };
  const measured = new Map();
  // Itératif : les grandes familles profondes ne saturent pas la pile JavaScript.
  for (const u of [...units].sort((a,b)=>b.generation-a.generation)) {
    u.owned.sort((a,b)=>a.members[0].localeCompare(b.members[0]));
    let cursor=0;
    const placements=[], anchors=[];
    for (const child of u.owned) {
      const m=measured.get(child);
      placements.push({ child, left:cursor });
      anchors.push(cursor+m.center+anchorOffset(u,child));
      cursor+=m.width+220;
    }
    const ownHalf=u.members.length===2?205:85;
    let center=anchors.length?(anchors[0]+anchors.at(-1))/2:ownHalf;
    const shift=Math.max(0,ownHalf-center);
    center+=shift;
    for(const p of placements)p.left+=shift;
    const right=Math.max(center+ownHalf,placements.length?cursor-220+shift:0);
    measured.set(u,{width:right,center,placements});
  }
  const positions={}, roots=units.filter(u=>!u.primary).sort((a,b)=>a.members[0].localeCompare(b.members[0]));
  let cursor=180;
  const queue=[];
  for(const root of roots){queue.push({u:root,left:cursor});cursor+=measured.get(root).width+650;}
  const min=units.length?Math.min(...units.map(u=>u.generation)):0;
  const max=units.length?Math.max(...units.map(u=>u.generation)):0;
  for(let i=0;i<queue.length;i++){
    const {u,left}=queue[i],m=measured.get(u);u.x=left+m.center;
    for(const id of u.members)positions[id]={x:u.x+memberOffset(u,id),y:350+(u.generation-min)*440};
    for(const p of m.placements)queue.push({u:p.child,left:left+p.left});
  }
  const contentWidth=roots.length?cursor-650+180:1700;
  const width=Math.max(1700,contentWidth),shift=(width-contentWidth)/2;
  for(const p of Object.values(positions))p.x+=shift;
  for(const u of units)u.x+=shift;
  return {units,unitOf,positions,width,height:Math.max(1000,350+(max-min+1)*440)};
}

// Cache local : une erreur réseau ne remplace jamais une photo valide.
async function avatar(id, users, loadImage, dir, memory, fetcher = globalThis.fetch) {
  if (libre(id) || !/^\d+$/.test(id)) return null;
  const cached = memory.get(id), file = path.join(dir,`${id}.png`);
  if (cached && Date.now()-cached.at<15*60*1000) return cached.image;
  try {
    const user = await users.fetch(id,{ force: true });
    const url = user.displayAvatarURL({ extension:'png', size:256, forceStatic:true });
    const response = await fetcher(url,{ signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer()), image = await loadImage(bytes);
    memory.set(id,{ image, at:Date.now() });
    try { fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(file+'.tmp',bytes); fs.renameSync(file+'.tmp',file); }
    catch (error) { console.warn('Cache photo non enregistré :',error.message); }
    return image;
  } catch {
    if (cached) { cached.at = Date.now()-14*60*1000; return cached.image; }
    try {
      const image = await loadImage(fs.readFileSync(file));
      memory.set(id,{ image, at:Date.now()-14*60*1000 }); return image;
    } catch { return null; }
  }
}

// Liens retranscrits depuis la capture fournie le 4 novembre 2026.
const REFERENCE_PEOPLE = {
  notfromparis: ['NOTFROMPARIS'], joliindienne: ['JOLIINDIENNE'],
  danette: ['DANETTE'], hakimi: ['HAKIMI'], numero5: ['N°5','N5','Nº5'],
  aiautomod: ['AI AUTOMOD','AI AUTOM0D'], free_dedemoff: ['FREE_DEDEMOFF'],
  empereur: ['EMP3REURQU3NTIN'], lulu3376: ['LULU3376'], sashayt: ['SASHAYT'],
  raf_gamer: ['RAF-GAMER'], emeraude: ['ÉMERAUDE'], amine24600: ['AMINE24600'], vgamer: ['VGAMER'],
};
const REFERENCE_PARENTS = [
  ['numero5','notfromparis'],['aiautomod','notfromparis'],['empereur','notfromparis'],
  ['free_dedemoff','danette'],['sashayt','danette'],['lulu3376','hakimi'],
  ['raf_gamer','free_dedemoff'],['emeraude','lulu3376'],['amine24600','lulu3376'],['vgamer','raf_gamer'],
];
const normalizedName = text => String(text||'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^a-z0-9]/g,'');
function referenceTree(ids) {
  const values = Object.keys(REFERENCE_PEOPLE).map(key=>ids[key]);
  if(values.some(id=>!/^\d+$/.test(id||'')) || new Set(values).size!==values.length)throw new Error('Les 14 membres du backup doivent être identifiés sans doublon.');
  const data={nodes:{}};
  for(const id of values)ensure(data,id);
  data.nodes[ids.notfromparis].spouse=ids.joliindienne;
  data.nodes[ids.joliindienne].spouse=ids.notfromparis;
  for(const [child,parent] of REFERENCE_PARENTS)data.nodes[ids[child]].parent=ids[parent];
  return normalize(data);
}
async function resolveReference(guild, overrides, knownIds=[]) {
  const pool=new Map(guild.members.cache), ids={}, missing=[];
  // Le bot peut avoir en cache les noms globaux même si la recherche serveur ne les indexe pas.
  for(const id of knownIds){
    if(libre(id)||pool.has(id))continue;
    const member=await guild.members.fetch(id).catch(()=>null);if(member)pool.set(id,member);
  }
  for(const [key,aliases]of Object.entries(REFERENCE_PEOPLE)){
    if(overrides[key]){
      const member=await guild.members.fetch(overrides[key]).catch(()=>null);
      if(!member){missing.push(`${key} : membre absent du serveur`);continue;}
      ids[key]=member.id;continue;
    }
    const queries=[...new Set(aliases.map(name=>name.replace(/[°º]/g,'').split(/[ _-]/)[0]))];
    let failed=false,truncated=false;
    for(const query of queries){
      try{
        const found=await guild.members.search({query,limit:100});
        if(found.size===100)truncated=true;
        for(const [id,member]of found)pool.set(id,member);
      }catch{failed=true;}
    }
    const names=new Set(aliases.map(normalizedName));
    const matches=[...pool.values()].filter(m=>[m.user.username,m.user.globalName,m.nickname].some(name=>names.has(normalizedName(name))));
    if(matches.length===1&&!failed&&!truncated)ids[key]=matches[0].id;
    else missing.push(`${key} : ${matches.length>1?'nom ambigu':failed?'recherche indisponible':truncated?'trop de résultats':'introuvable'}`);
  }
  if(missing.length)throw new Error('Backup #1 non restauré. Sélectionne ces membres dans les options de /backup retour:1 : '+missing.join(' ; '));
  return referenceTree(ids);
}

async function start() {
  require('dotenv').config({ path:path.join(__dirname,'.env') });
  const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, AttachmentBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ActivityType } = require('discord.js');
  const { createCanvas, loadImage, registerFont } = require('canvas');
  const token = process.env.DISCORD_TOKEN, appId = process.env.CLIENT_ID, guildId = process.env.GUILD_ID;
  const owners = String(process.env.OWNER_ID||'').split(',').map(x=>x.trim()).filter(Boolean);
  if (!token || !appId || !guildId || !owners.length) throw new Error('Variables .env manquantes : DISCORD_TOKEN, CLIENT_ID, GUILD_ID, OWNER_ID.');
  const dataDir = path.join(__dirname,'data'), familyFile = path.join(dataDir,'family.json');
  const referenceFile = path.join(dataDir,'reference-backup-1.json');
  const backupDir = path.join(dataDir,'backups'), requestsFile = path.join(dataDir,'pending_requests.json');
  fs.mkdirSync(backupDir,{recursive:true});
  const write = (file,value) => { fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2)); fs.renameSync(file+'.tmp',file); };
  const read = (file, fallback) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : fallback;
  // Un fichier vide ou invalide n'est jamais remplacé automatiquement par un vieil arbre.
  if (!fs.existsSync(familyFile)) write(familyFile,{nodes:{}});
  const load = () => clean(read(familyFile,{nodes:{}}));
  function backup(reason) {
    const data = load();
    if (!Object.keys(data.nodes).length) return;
    write(path.join(backupDir,`${Date.now()}_${require('node:crypto').randomUUID()}_${reason}.json`),data);
    const files = fs.readdirSync(backupDir).filter(x=>x.endsWith('.json')).sort().reverse();
    for (const file of files.slice(30)) fs.unlinkSync(path.join(backupDir,file));
  }
  function commit(data,reason) {
    clean(data); backup(reason); write(familyFile,data);
    if (Object.keys(data.nodes).length) write(path.join(dataDir,'family.last_good.json'),data);
  }
  let requests = read(requestsFile,{requests:{}});
  const saveRequests = () => write(requestsFile,requests);
  const owner = id => owners.includes(id), cooldowns = new Map(), memory = new Map();
  function list(kind) {
    const file = path.join(__dirname,`${kind}.txt`), key = `PERSONNES_${kind.toUpperCase()}=`;
    const line = fs.existsSync(file) ? fs.readFileSync(file,'utf8').split(/\r?\n/).find(l=>l.startsWith(key)) || key : key;
    return line.slice(key.length).split(',').map(x=>x.trim()).filter(Boolean);
  }
  const labels = { enfant:'Enfant', parent:'Parent', frere_soeur:'Frère / Sœur', cousin_cousine:'Cousin / Cousine', mari_fiancee:'Mari / Fiancée' };
  const commands = [
    new SlashCommandBuilder().setName('lier').setDescription('Demander ou créer un lien familial')
      .addUserOption(o=>o.setName('qui').setDescription('La personne à lier').setRequired(true))
      .addUserOption(o=>o.setName('avec').setDescription('La personne de référence').setRequired(true))
      .addStringOption(o=>o.setName('lien').setDescription('Lien de QUI par rapport à AVEC').setRequired(true).addChoices(...Object.entries(labels).map(([value,name])=>({name,value})))),
    new SlashCommandBuilder().setName('arbre').setDescription('Afficher l’arbre'),
    new SlashCommandBuilder().setName('backup').setDescription('Restaurer une sauvegarde')
      .addIntegerOption(o=>o.setName('retour').setDescription('Changements à annuler').setRequired(true).addChoices({name:'Backup #1 — arbre de référence',value:1},...[3,5,10].map(value=>({name:`${value} changements`,value}))))
      .addUserOption(o=>o.setName('notfromparis').setDescription('Backup #1 : NOTFROMPARIS'))
      .addUserOption(o=>o.setName('joliindienne').setDescription('Backup #1 : JOLIINDIENNE'))
      .addUserOption(o=>o.setName('danette').setDescription('Backup #1 : DANETTE'))
      .addUserOption(o=>o.setName('hakimi').setDescription('Backup #1 : HAKIMI'))
      .addUserOption(o=>o.setName('numero5').setDescription('Backup #1 : N°5'))
      .addUserOption(o=>o.setName('aiautomod').setDescription('Backup #1 : AI AUTOMOD'))
      .addUserOption(o=>o.setName('free_dedemoff').setDescription('Backup #1 : FREE_DEDEMOFF'))
      .addUserOption(o=>o.setName('empereur').setDescription('Backup #1 : EMP3REURQU3NTIN'))
      .addUserOption(o=>o.setName('lulu3376').setDescription('Backup #1 : LULU3376'))
      .addUserOption(o=>o.setName('sashayt').setDescription('Backup #1 : SASHAYT'))
      .addUserOption(o=>o.setName('raf_gamer').setDescription('Backup #1 : RAF-GAMER'))
      .addUserOption(o=>o.setName('emeraude').setDescription('Backup #1 : ÉMERAUDE'))
      .addUserOption(o=>o.setName('amine24600').setDescription('Backup #1 : AMINE24600'))
      .addUserOption(o=>o.setName('vgamer').setDescription('Backup #1 : VGAMER')),
    ...['blacklist','whitelist'].map(kind=>new SlashCommandBuilder().setName(kind).setDescription(`Modifier la ${kind}`)
      .addUserOption(o=>o.setName('membre').setDescription('Membre concerné').setRequired(true))
      .addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true).addChoices({name:'Ajouter',value:'add'},{name:'Retirer',value:'remove'}))),
    new SlashCommandBuilder().setName('reset').setDescription('Réinitialiser l’arbre'),
    new SlashCommandBuilder().setName('supprimer').setDescription('Supprimer une personne ou les places libres seules')
      .addStringOption(o=>o.setName('mode').setDescription('Mode').setRequired(true).addChoices({name:'Une personne',value:'personne'},{name:'Places libres seules',value:'libres_seules'}))
      .addUserOption(o=>o.setName('qui').setDescription('Personne à supprimer')),
  ];
  let font = 'Arial';
  for (const file of ['Nunito-Bold.ttf','Nunito-VariableFont_wght.ttf']) {
    const full = path.join(__dirname,'fonts',file);
    if (fs.existsSync(full)) { try { registerFont(full,{family:'Nunito',weight:'700'}); font='Nunito'; break; } catch {} }
  }
  const client = new Client({intents:[GatewayIntentBits.Guilds]});
  client.on('error',console.error);
  async function profile(guild,id) {
    if (libre(id)) return { name:'LIBRE', color:'#171717', image:null };
    const image = await avatar(id,client.users,loadImage,path.join(dataDir,'avatars'),memory);
    const user = await client.users.fetch(id).catch(()=>null);
    const member = guild ? await guild.members.fetch(id).catch(()=>null) : null;
    return { image, name:user?.globalName || user?.username || `MEMBRE ${id.slice(-4)}`, color:member?.displayHexColor && member.displayHexColor!=='#000000' ? member.displayHexColor : '#171717' };
  }
  function textLines(ctx,text) {
    const chars = [...String(text).toUpperCase()], lines = []; let line='';
    for (const char of chars) {
      if (ctx.measureText(line+char).width>185 && line) { lines.push(line); line=''; }
      line+=char;
      if (lines.length===3) break;
    }
    if (line) lines.push(line);
    if (lines.length===3 && chars.join('').length>lines.join('').length) lines[2]=lines[2].slice(0,-1)+'…';
    return lines;
  }
  async function render(data,guild) {
    const l = layout(clone(data)), profiles = new Map(), ids = Object.keys(l.positions);
    // Concurrence limitée pour éviter une rafale de requêtes sur les grands arbres.
    let next=0;
    await Promise.all(Array.from({length:Math.min(4,ids.length)},async()=>{
      while(next<ids.length) { const id=ids[next++]; profiles.set(id,await profile(guild,id)); }
    }));
    // Plusieurs panneaux gardent les très grands arbres lisibles sans canvas géant.
    const tileW=6000, tileH=4000, cols=Math.ceil(l.width/tileW), rows=Math.ceil(l.height/tileH);
    if (cols*rows>100) throw new Error('Arbre trop grand pour un seul envoi (plus de 100 panneaux). Les liens sont enregistrés.');
    const files=[];
    for(let row=0;row<rows;row++) for(let col=0;col<cols;col++) {
      const x0=col*tileW,y0=row*tileH,w=Math.min(tileW,l.width-x0),h=Math.min(tileH,l.height-y0);
      const canvas=createCanvas(w,h),ctx=canvas.getContext('2d');
      ctx.fillStyle='#f7f6df';ctx.fillRect(0,0,w,h);ctx.translate(-x0,-y0);
      ctx.fillStyle='#050505';ctx.fillRect(l.width/2-390,65,780,130);
      ctx.fillStyle='white';ctx.font=`700 64px ${font}`;ctx.textAlign='center';ctx.fillText('EMPIRE TREE',l.width/2,150);
      ctx.lineWidth=3;ctx.strokeStyle='#333';
      const line=(points)=>{ctx.beginPath();points.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y));ctx.stroke();};
      // Chaque personne reçoit son propre lien d'ascendance, même si son conjoint vient d'une autre famille.
      // Pistes distinctes entre les rangées : aucun trait ne traverse un avatar ou un nom.
      for(const level of [...new Set(l.units.map(u=>u.generation))]) {
        const families=l.units.filter(u=>u.generation===level && u.children.size);
        families.forEach((u,index)=>{
          const y=l.positions[u.members[0]].y, bus=y+200+(index+1)*110/(families.length+1);
          const targets=Object.entries(data.nodes).filter(([,n])=>u.members.includes(n.parent)).map(([id])=>l.positions[id]);
          if(!targets.length)return;
          const center=u.members.reduce((sum,id)=>sum+l.positions[id].x,0)/u.members.length;
          const start=y+(u.members.length===2?0:156);
          if(targets.length===1 && Math.abs(targets[0].x-center)<0.01){
            line([[center,start],[center,targets[0].y-67]]);return;
          }
          line([[center,start],[center,bus]]);
          const xs=[center,...targets.map(p=>p.x)];line([[Math.min(...xs),bus],[Math.max(...xs),bus]]);
          for(const p of targets)line([[p.x,bus],[p.x,p.y-67]]);
        });
      }
      for(const u of l.units)if(u.members.length===2){const a=l.positions[u.members[0]],b=l.positions[u.members[1]];line([[a.x+64,a.y],[b.x-64,b.y]]);}
      for(const id of ids){
        const p=l.positions[id];if(p.x+120<x0||p.x-120>x0+w||p.y+160<y0||p.y-65>y0+h)continue;
        const info=profiles.get(id);ctx.save();ctx.beginPath();ctx.arc(p.x,p.y,61,0,Math.PI*2);ctx.fillStyle='white';ctx.fill();ctx.strokeStyle=info.color;ctx.lineWidth=6;ctx.stroke();
        ctx.beginPath();ctx.arc(p.x,p.y,52,0,Math.PI*2);ctx.clip();
        if(info.image)ctx.drawImage(info.image,p.x-52,p.y-52,104,104);
        else{ctx.fillStyle='#aacb7a';ctx.fillRect(p.x-52,p.y-52,104,104);ctx.fillStyle='#27402c';ctx.font=`700 36px ${font}`;ctx.textAlign='center';ctx.fillText(libre(id)?'?':info.name[0].toUpperCase(),p.x,p.y+13);}
        ctx.restore();ctx.fillStyle='#111';ctx.font=`700 18px ${font}`;ctx.textAlign='center';
        textLines(ctx,info.name).forEach((text,i)=>ctx.fillText(text,p.x,p.y+92+i*23));
      }
      ctx.setTransform(1,0,0,1,0,0);ctx.fillStyle='#555';ctx.font=`16px ${font}`;ctx.textAlign='left';
      ctx.fillText(`Empire Tree · panneau ${col+1}/${cols}, ${row+1}/${rows}`,18,h-18);
      files.push(new AttachmentBuilder(canvas.toBuffer('image/png'),{name:`arbre-${row+1}-${col+1}.png`}));
    }
    return files;
  }
  async function show(interaction,data,content='🌳 Empire Tree') {
    const files=await render(data,interaction.guild);
    await interaction.editReply({content,files:files.slice(0,10),components:[]});
    for(let i=10;i<files.length;i+=10)await interaction.followUp({files:files.slice(i,i+10)});
  }
  // Les écritures restent synchrones ; les données sont relues après chaque attente Discord.
  // La file empêche deux acceptations simultanées d'appliquer deux fois la même demande.
  let queue=Promise.resolve();
  async function handle(i) {
    if(i.guildId!==guildId)return;
    const respond = options => { const {ephemeral,...payload}=options; return i.isButton() ? i.followUp({...payload,ephemeral:true}) : i.editReply(payload); };
    if(i.isButton()) {
      const [action,id]=i.customId.split(':'); if(!['accept','reject'].includes(action))return;
      const request=requests.requests[id];
      if(!request)return respond({content:'Cette demande a déjà été traitée.',ephemeral:true});
      if(i.user.id!==request.targetId&&!owner(i.user.id))return respond({content:'Seule la personne concernée peut répondre.',ephemeral:true});
      if(action==='reject'){delete requests.requests[id];saveRequests();return i.editReply({content:'❌ Demande refusée.',components:[]});}
      
      if(list('blacklist').includes(request.requesterId)||list('blacklist').includes(request.targetId))throw new Error('Une des personnes est blacklistée.');
      const data=relate(load(),request.requesterId,request.targetId,request.lien);
      commit(data,'accept_lier');delete requests.requests[id];saveRequests();
      await i.editReply({content:'✅ Lien accepté et enregistré.',components:[]});
      // Un nouveau message contient l'arbre, la demande originale reste clôturée.
      const files=await render(data,i.guild);
      for(let n=0;n<files.length;n+=10)await i.followUp({files:files.slice(n,n+10)});
      return;
    }
    if(!i.isChatInputCommand())return;
    const command=i.commandName;
    if(['backup','reset','blacklist','whitelist'].includes(command)&&!owner(i.user.id))throw new Error('Commande réservée à l’admin.');
    if(['blacklist','whitelist'].includes(command)){
      const member=i.options.getUser('membre'),action=i.options.getString('action'),ids=new Set(list(command));
      if(action==='add')ids.add(member.id);else ids.delete(member.id);
      fs.writeFileSync(path.join(__dirname,`${command}.txt`),`PERSONNES_${command.toUpperCase()}=${[...ids].join(',')}`);
      cooldowns.delete(member.id);return respond({content:`✅ ${command} mise à jour.`,ephemeral:true});
    }
    if(command==='lier'){
      const a=i.options.getUser('qui'),b=i.options.getUser('avec'),relation=i.options.getString('lien');
      if(!owner(i.user.id)&&a.id!==i.user.id)throw new Error('Tu ne peux demander un lien que pour toi-même.');
      if(list('blacklist').includes(a.id)||list('blacklist').includes(b.id))throw new Error('Une des personnes est blacklistée.');
      const exempt=owner(i.user.id)||list('whitelist').includes(i.user.id);
      const remaining=600000-(Date.now()-(cooldowns.get(i.user.id)||0));
      if(!exempt&&remaining>0)throw new Error(`Attends encore ${Math.ceil(remaining/60000)} min avant /lier.`);
      
      const data=relate(load(),a.id,b.id,relation);
      if(owner(i.user.id)){commit(data,'admin_lier');return show(i,data,`✅ ${a.username} → ${b.username} : ${labels[relation]}.`);}
      const id=require('node:crypto').randomUUID();
      requests.requests[id]={requestId:id,requesterId:a.id,targetId:b.id,lien:relation,guildId:i.guildId,channelId:i.channelId,createdAt:Date.now()};saveRequests();
      if(!exempt)cooldowns.set(i.user.id,Date.now());
      const row=new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`accept:${id}`).setLabel('Accepter').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`reject:${id}`).setLabel('Refuser').setStyle(ButtonStyle.Danger));
      return i.editReply({content:`🌳 <@${a.id}> souhaite se lier à <@${b.id}> : **${labels[relation]}** (lien de la première personne par rapport à la seconde).`,components:[row],allowedMentions:{users:[b.id]}});
    }
    if(command==='arbre'){return show(i,load());}
    if(command==='backup'){
      const steps=i.options.getInteger('retour');
      if(steps===1){
        let data;
        if(fs.existsSync(referenceFile))data=normalize(clean(read(referenceFile)));
        else{
          const overrides=Object.fromEntries(Object.keys(REFERENCE_PEOPLE).map(key=>[key,i.options.getUser(key)?.id]));
          data=await resolveReference(i.guild,overrides,Object.keys(load().nodes));
          write(referenceFile,data);
        }
        commit(data,'before_reference_restore');
        requests={requests:{}};saveRequests();
        return show(i,data,'✅ Backup #1 restauré : arbre de référence. Les demandes antérieures sont annulées.');
      }
      const files=fs.readdirSync(backupDir).filter(f=>f.endsWith('.json')).sort().reverse();
      if(files.length<steps)throw new Error(`Seulement ${files.length} sauvegardes disponibles.`);
      const data=clean(read(path.join(backupDir,files[steps-1])));normalize(data);
      commit(data,'before_restore');return show(i,data,`✅ Retour de ${steps} sauvegardes.`);
    }
    if(command==='reset'){commit({nodes:{}},'reset');requests={requests:{}};saveRequests();return respond({content:'🌳 Arbre réinitialisé.',ephemeral:true});}
    if(command==='supprimer'){
      const mode=i.options.getString('mode'),who=i.options.getUser('qui');
      if(mode==='libres_seules'&&!owner(i.user.id))throw new Error('Commande réservée à l’admin.');
      if(mode!=='libres_seules'&&(!who||(!owner(i.user.id)&&who.id!==i.user.id)))throw new Error('Choisis ta propre personne à supprimer, ou utilise un compte admin.');
      const data=load();
      if(mode==='libres_seules'){
        let changed=true;
        while(changed){changed=false;for(const [id,n]of Object.entries(data.nodes))if(libre(id)&&!n.spouse&&!Object.values(data.nodes).some(child=>child.parent===id)){delete data.nodes[id];changed=true;}}
      }else{
        if(!data.nodes[who.id])throw new Error('Cette personne n’est pas dans l’arbre.');
        const spouse=data.nodes[who.id].spouse;delete data.nodes[who.id];
        for(const n of Object.values(data.nodes)){if(n.parent===who.id)n.parent=spouse||null;if(n.spouse===who.id)n.spouse=null;}
      }
      commit(data,'supprimer');return show(i,data,'✅ Suppression enregistrée.');
    }
  }
  client.on('interactionCreate',i=>{
    // Accuser réception tout de suite, même si un grand rendu est en cours.
    if(i.guildId!==guildId)return;
    const ack = (i.isChatInputCommand() || (i.isButton() && /^(accept|reject):/.test(i.customId)))
      ? (i.isButton()?i.deferUpdate():i.deferReply({ephemeral:['backup','reset','blacklist','whitelist'].includes(i.commandName)})) : null;
    if(!ack)return;
    queue=queue.then(async()=>{await ack;await handle(i);}).catch(async error=>{
      console.error(error);
      try{
        await ack;
        const payload={content:`❌ ${error.message||'Une erreur est survenue.'}`};
        if(i.isButton())await i.followUp({...payload,ephemeral:true});
        else await i.editReply({...payload,components:[]});
      }catch(e){console.error('Réponse impossible :',e.message);}
    });
  });
  client.once('ready',()=>{
    console.log(`✅ Connecté : ${client.user.tag}`);
    client.user.setPresence({activities:[{name:'Fear Among Us',type:ActivityType.Streaming,url:'https://www.twitch.tv/discord'}],status:'online'});
  });
  // Valider les données sans les modifier avant toute connexion.
  load();
  await new REST({version:'10'}).setToken(token).put(Routes.applicationGuildCommands(appId,guildId),{body:commands.map(c=>c.toJSON())});
  await client.login(token);
}
module.exports = { relate, normalize, layout, avatar, clean, referenceTree, resolveReference, REFERENCE_PEOPLE };
if(require.main===module)start().catch(error=>{console.error('❌ Démarrage impossible :',error);process.exitCode=1;});
