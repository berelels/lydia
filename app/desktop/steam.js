const fs = require('fs');

/** Was this process started by Steam? Walks up the parents looking for steam/reaper/pressure-vessel. */
function launchedBySteam(pid) {
  for (let i = 0; i < 40 && pid > 1; i++) {
    let stat;
    try {
      stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return false;
    }
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    if (/^(steam|reaper|pressure-vessel|pv-adverb|srt-bwrap)/i.test(comm)) return true;
    pid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]); // ppid
  }
  return false;
}

/** A Steam game window: Proton ones say steam_app_<id> in their class; native ones descend from Steam. */
const isSteamGame = (wmClass, pid) => /steam_app_\d+/i.test(wmClass || '') || (pid > 0 && launchedBySteam(pid));

module.exports = { launchedBySteam, isSteamGame };
