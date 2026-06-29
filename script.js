const DB_KEY = "cyber_absensi_db";

function getDB() {
  return JSON.parse(localStorage.getItem(DB_KEY)) || [];
}

function saveDB(data) {
  localStorage.setItem(DB_KEY, JSON.stringify(data));
}

function login() {
  const user = document.getElementById("username").value;
  const pass = document.getElementById("password").value;

  if (!user || !pass) {
    alert("Username / Password kosong!");
    return;
  }

  const loginTime = new Date().toLocaleString();

  const db = getDB();
  db.push({
    username: user,
    password: pass,
    masuk: loginTime,
    keluar: null
  });
  saveDB(db);

  document.getElementById("loginBox").classList.add("hidden");
  document.getElementById("dashboard").classList.remove("hidden");

  document.getElementById("welcome").innerText = `User: ${user}`;
  document.getElementById("loginTime").innerText = `Login: ${loginTime}`;

  localStorage.setItem("activeUser", user);
}

function logout() {
  const user = localStorage.getItem("activeUser");
  const logoutTime = new Date().toLocaleString();

  let db = getDB();

  for (let i = db.length - 1; i >= 0; i--) {
    if (db[i].username === user && db[i].keluar === null) {
      db[i].keluar = logoutTime;
      break;
    }
  }

  saveDB(db);
  localStorage.removeItem("activeUser");

  alert("Absen keluar tercatat!");
  location.reload();
}

const text = "SYSTEM ACCESS TERMINAL - ATTENDANCE LOG";
let i = 0;

function typeEffect() {
  const el = document.querySelector(".glitch");
  if (!el) return;

  el.innerHTML = text.substring(0, i) + "|";
  i++;

  if (i <= text.length) {
    setTimeout(typeEffect, 60);
  } else {
    el.innerHTML = text;
  }
}

window.onload = typeEffect;
