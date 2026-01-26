const searchBox = document.getElementById("stationSearch");
const suggestBox = document.getElementById("stationSuggest");
const weatherBox = document.getElementById("weatherBox");

/*let activeIndex = -1;*/
let weatherActiveIndex = -1;

/* ================= SUGGEST ================= */
searchBox.addEventListener("input", async () => {
  const q = searchBox.value.trim();
  weatherActiveIndex = -1;

  if (!q) {
    suggestBox.style.display = "none";
    return;
  }

  try {
    const res = await fetch(`/api/stations?q=${encodeURIComponent(q)}`);
    const list = await res.json();

    if (!list.length) {
      suggestBox.innerHTML = `
        <div class="p-2 text-muted text-center">No station found</div>
      `;
      suggestBox.style.display = "block";
      return;
    }

    suggestBox.innerHTML = list
      .map(
        (s, i) => `
        <div
          class="p-2 suggest-item"
          data-index="${i}"
          style="cursor:pointer; border-bottom:1px solid #eee;"
          onclick="selectStation('${s.code}')"
        >
          <b>${s.code}</b> — ${s.name}
        </div>
      `
      )
      .join("");

    suggestBox.style.display = "block";
  } catch {
    suggestBox.style.display = "none";
  }
});

/* ================= KEYBOARD NAV ================= */
searchBox.addEventListener("keydown", e => {
  const items = suggestBox.querySelectorAll(".suggest-item");
  if (!items.length) return;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    weatherActiveIndex = (weatherActiveIndex + 1) % items.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    weatherActiveIndex = (weatherActiveIndex - 1 + items.length) % items.length;
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (weatherActiveIndex >= 0) {
      items[weatherActiveIndex].click();
    }
    return;
  }

  items.forEach((el, i) => {
    el.style.background = i === weatherActiveIndex ? "#e8f0ff" : "";
  });
});

/* ================= SELECT STATION ================= */
async function selectStation(code) {
  suggestBox.style.display = "none";
  searchBox.value = code;

  try {
    const res = await fetch(`/api/weather?station=${code}`);
    if (!res.ok) throw new Error();

    const data = await res.json();
    renderWeather(data);
  } catch {
    weatherBox.innerHTML = "❌ Weather not available";
  }
}

/* ================= RENDER WEATHER ================= */
function renderWeather(data) {
  const w = data.weather;
  const s = data.station;

  const rain =
    w.forecast.forecastday[0].day.daily_chance_of_rain || 0;

  const visibilityKm = w.current.vis_km || 0;
  const visibilityM = Math.round(visibilityKm * 1000);

  // 🌫️ Fog Logic
  let fogStatus = "Clear";
  if (visibilityM < 500) fogStatus = "DENSE FOG";
  else if (visibilityM < 1000) fogStatus = "FOG";

  // 🚨 Alert Logic
  let alert = "🟢 NORMAL";
  if (rain > 80 || visibilityM < 500) alert = "🔴 DANGER";
  else if (rain > 60 || visibilityM < 1000) alert = "🟡 CAUTION";

  weatherBox.innerHTML = `
    📍 ${s.name}<br>
    🌡️ ${w.current.temp_c}°C | ${w.current.condition.text}<br>
    🌧️ Rain: ${rain}% | 🌫️ ${fogStatus}<br>
    🚨 ${alert}
  `;
}

/* ================= CLICK OUTSIDE ================= */
document.addEventListener("click", e => {
  if (!suggestBox.contains(e.target) && e.target !== searchBox) {
    suggestBox.style.display = "none";
  }
});
