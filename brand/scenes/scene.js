// Fixture content for the brand photographs. Real components (web/js/turn.js, web/app.css) filled with a plausible
// conversation; nothing here is shipped to users.
import { Turn, el } from "/js/turn.js";
import { icon } from "/js/icons.js";

export const CHATS = ["Plan a 3-day trip to Kyoto", "Summarise the meeting notes", "Explain DNS records simply", "⏰ Morning tech news", "Draft a polite decline email"];

export function sidebar(root, active = 0) {
  root.innerHTML = `<div class="side-h"><div class="brand"><div class="logo"></div>ChocoAI</div><button class="iconbtn">${icon("clock", 20)}</button><button class="iconbtn">${icon("plus", 20)}</button><button class="iconbtn">${icon("sidebar", 20)}</button></div>
  <div class="list">${CHATS.map((t, i) => `<div class="row" data-on="${i === active}"><button class="open"><span class="t">${t}</span><small>${["Today", "Today", "Yesterday", "Yesterday", "19 Nov"][i]}</small></button><button class="del">${icon("trash", 18)}</button></div>`).join("")}</div>
  <div class="side-f"><button class="me"><span class="avatar">y</span><span>you@chocorot.net</span></button></div>`;
}

export function conversation(col, { full = true } = {}) {
  const user = (t) => { const m = el("div", "msg user"); const b = el("div", "bubble"); b.textContent = t; m.append(b); col.append(m); };
  const ai = () => { const r = el("div", "msg ai", `<div class="logo"></div>`); col.append(r); return new Turn(r, { live: false }); };
  user("Plan a 3-day trip to Kyoto and check the weather for next week.");
  const t = ai();
  t.think("The user wants a short itinerary and the forecast. Plan first, then search."); t.flushNow(); t.closeCur();
  t.root.querySelector(".lbl").textContent = "Thought for 6s";
  if (full) {
    t.tool({ id: "p", name: "update_plan", args: {} });
    t.plan([{ text: "Check the forecast", status: "done" }, { text: "Pick sights for each day", status: "doing" }, { text: "Write the itinerary", status: "todo" }]);
  }
  t.tool({ id: "a", name: "web_search", args: { query: "Kyoto weather forecast next week" } });
  t.result({ id: "a", d: "Sunny, 18°C", ok: true });
  t.text("## Your 3 days in Kyoto\n\nSunny and about **18°C** all week, so mornings outdoors work well:\n\n1. **Day 1:** Fushimi Inari at sunrise, then Gion in the evening\n2. **Day 2:** Arashiyama bamboo grove and the monkey park\n3. **Day 3:** Kiyomizu-dera, then a tea ceremony\n\n> Book the tea ceremony a few days ahead.");
  t.end();
  return t;
}
