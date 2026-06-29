const DB_KEY="cyber_db";

function getDB(){
return JSON.parse(localStorage.getItem(DB_KEY))||[];
}
function saveDB(d){
localStorage.setItem(DB_KEY,JSON.stringify(d));
}

function simpleHash(s){
let h=0;
for(let i=0;i<s.length;i++){
h=(h<<5)-h+s.charCodeAt(i);
}
return h;
}

function playBeep(){
const b=document.getElementById("beep");
b.currentTime=0;
b.play();
}

function renderLog(){
const db=getDB();
const c=document.getElementById("logTable");
if(!c)return;

let html="<table border='1' style='width:100%;color:#00ff66;border-color:#00ff66'>";
html+="<tr><th>User</th><th>Masuk</th><th>Keluar</th><th>Status</th></tr>";

db.forEach(d=>{
html+=`<tr>
<td>${d.username}</td>
<td>${d.masuk}</td>
<td>${d.keluar||'-'}</td>
<td>${d.keluar?'SELESAI':'AKTIF'}</td>
</tr>`;
});

html+="</table>";
c.innerHTML=html;
}

function login(){
const u=document.getElementById("username").value;
const p=document.getElementById("password").value;

if(!u||!p){alert("kosong");return;}

playBeep();

const db=getDB();
db.push({
username:u,
password:simpleHash(p),
masuk:new Date().toLocaleString(),
keluar:null
});
saveDB(db);

localStorage.setItem("activeUser",u);

document.getElementById("loginBox").classList.add("hidden");
document.getElementById("dashboard").classList.remove("hidden");

document.getElementById("welcome").innerText="User: "+u;
document.getElementById("loginTime").innerText="Login: "+new Date().toLocaleString();

renderLog();
}

function logout(){
playBeep();

const u=localStorage.getItem("activeUser");
const db=getDB();

for(let i=db.length-1;i>=0;i--){
if(db[i].username===u && !db[i].keluar){
db[i].keluar=new Date().toLocaleString();
break;
}
}

saveDB(db);
localStorage.removeItem("activeUser");

renderLog();
alert("Absen keluar");
location.reload();
}

const bootLines=[
"Initializing system...",
"Loading modules...",
"Decrypting layer...",
"Connecting node...",
"SYSTEM READY"
];

let i=0;

function boot(){
const el=document.getElementById("bootText");
if(i<bootLines.length){
el.innerText+=bootLines[i]+"
";
i++;
setTimeout(boot,700);
}else{
setTimeout(()=>{
document.getElementById("boot").style.display="none";
document.getElementById("app").classList.remove("hidden");
typeEffect();
},800);
}
}

const text="SYSTEM ACCESS TERMINAL - ATTENDANCE LOG";
let t=0;

function typeEffect(){
const el=document.querySelector(".glitch");
if(!el)return;

el.innerText=text.substring(0,t)+"|";
t++;

if(t<=text.length)setTimeout(typeEffect,50);
else el.innerText=text;
}

window.onload=boot;
