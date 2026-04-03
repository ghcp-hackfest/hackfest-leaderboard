/**
 * GHCP HackFest — Leaderboard App
 *
 * GitHub API를 통해 scores/ 디렉토리의 JSON 파일들을 읽어
 * 실시간으로 팀별 점수를 집계하고 표시합니다.
 *
 * GitHub Pages에서 동작: https://[org].github.io/hackfest-leaderboard
 */

// ── 설정 ────────────────────────────────────────────────────
const CONFIG = {
    // ⚠️ 이 값들을 실제 Organization/Repo로 변경하세요
    GITHUB_ORG: 'ghcp-hackfest',
    LEADERBOARD_REPO: 'hackfest-leaderboard',
    SCORES_PATH: 'scores',
    REFRESH_INTERVAL_MS: 30_000,  // 30초 자동 새로고침

    // 미션별 최대 점수
    MAX_SCORES: {
        'mission-01': 100,
        'mission-02': 150,
    },

    // 최초 완료 보너스
    FIRST_COMPLETE_BONUS: 30,
};

// ── 상태 ────────────────────────────────────────────────────
let state = {
    scores: {},        // { teamName: { mission-01: {...}, mission-02: {...} } }
    currentFilter: 'all',
    prevTotals: {},    // 이전 총점 기록 (변화 감지용)
    firstCompletion: {}, // { 'mission-01': 'teamName', 'mission-02': 'teamName' }
};
let refreshTimer = null;
let countdownTimer = null;
let countdown = CONFIG.REFRESH_INTERVAL_MS / 1000;

// ── 초기화 ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    loadScores();
    startAutoRefresh();
});

// ── 점수 로드 ────────────────────────────────────────────────
async function loadScores() {
    setStatus('loading');
    try {
        const apiBase = `https://api.github.com/repos/${CONFIG.GITHUB_ORG}/${CONFIG.LEADERBOARD_REPO}/contents/${CONFIG.SCORES_PATH}`;
        const res = await fetch(apiBase, {
            headers: { 'Accept': 'application/vnd.github.v3+json' }
        });

        if (!res.ok) {
            if (res.status === 404) {
                // scores/ 폴더가 아직 없음 (이벤트 시작 전)
                renderEmptyState();
                return;
            }
            throw new Error(`GitHub API error: ${res.status}`);
        }

        const files = await res.json();
        const jsonFiles = files.filter(f => f.name.endsWith('.json'));

        // 파일들을 병렬로 로드
        const scoreData = await Promise.all(
            jsonFiles.map(f => fetchScoreFile(f.download_url))
        );

        // 상태 업데이트
        const newScores = {};
        scoreData.filter(Boolean).forEach(data => {
            if (!newScores[data.team]) newScores[data.team] = {};
            newScores[data.team][data.mission] = data;
        });

        detectChanges(newScores);
        state.scores = newScores;
        calculateFirstCompletions();
        render();
        setStatus('live');

    } catch (err) {
        console.error('Score load failed:', err);
        setStatus('error');
        // 에러 시 마지막 성공 데이터 유지
        if (Object.keys(state.scores).length > 0) render();
    }
}

async function fetchScoreFile(url) {
    try {
        const res = await fetch(url + '?t=' + Date.now()); // cache bypass
        if (!res.ok) return null;
        return await res.json();
    } catch {
        return null;
    }
}

// ── 최초 완료 팀 계산 ────────────────────────────────────────
function calculateFirstCompletions() {
    const missions = ['mission-01', 'mission-02'];
    missions.forEach(mission => {
        let earliest = null;
        let earliestTeam = null;
        Object.entries(state.scores).forEach(([team, scores]) => {
            const missionScore = scores[mission];
            if (!missionScore) return;
            const isComplete = getTotalForMission(missionScore, mission) >= CONFIG.MAX_SCORES[mission];
            if (isComplete) {
                const ts = new Date(missionScore.timestamp);
                if (!earliest || ts < earliest) {
                    earliest = ts;
                    earliestTeam = team;
                }
            }
        });
        if (earliestTeam) state.firstCompletion[mission] = earliestTeam;
    });
}

// ── 점수 계산 ────────────────────────────────────────────────
function getTotalForMission(missionData, mission) {
    if (!missionData) return 0;
    return missionData.score || 0;
}

function getTeamTotal(team) {
    const teamScores = state.scores[team] || {};
    let total = 0;
    Object.entries(teamScores).forEach(([mission, data]) => {
        total += getTotalForMission(data, mission);
        // 최초 완료 보너스
        if (state.firstCompletion[mission] === team) {
            total += CONFIG.FIRST_COMPLETE_BONUS;
        }
    });
    return total;
}

// ── 변화 감지 (Toast 알림) ───────────────────────────────────
function detectChanges(newScores) {
    Object.entries(newScores).forEach(([team, missions]) => {
        const newTotal = Object.values(missions).reduce((sum, m) => sum + (m.score || 0), 0);
        const prevTotal = state.prevTotals[team] || 0;
        if (prevTotal > 0 && newTotal > prevTotal) {
            showToast(`🎉 ${team} +${newTotal - prevTotal}점 획득!`);
        }
        state.prevTotals[team] = newTotal;
    });
}

// ── 렌더링 ──────────────────────────────────────────────────
function render() {
    const teams = getSortedTeams();
    renderPodium(teams.slice(0, 3));
    renderTable(teams);
    document.getElementById('last-updated').textContent =
        '최종 업데이트: ' + new Date().toLocaleTimeString('ko-KR');
}

function getSortedTeams() {
    return Object.keys(state.scores)
        .map(team => ({ team, total: getTeamTotal(team) }))
        .sort((a, b) => b.total - a.total || a.team.localeCompare(b.team));
}

function renderEmptyState() {
    document.getElementById('leaderboard-body').innerHTML =
        `<tr><td colspan="6" class="loading">🏁 이벤트 시작을 기다리는 중...</td></tr>`;
}

// ── 포디움 ──────────────────────────────────────────────────
function renderPodium(top3) {
    const crowns = ['🥇', '🥈', '🥉'];
    const rankClass = ['rank-1', 'rank-2', 'rank-3'];
    const rankLabel = ['1ST', '2ND', '3RD'];

    document.getElementById('podium').innerHTML = top3.map((entry, i) =>
        `<div class="podium-item ${rankClass[i]}">
            <div class="podium-crown">${crowns[i]}</div>
            <div class="podium-rank">${rankLabel[i]}</div>
            <div class="podium-team">${escapeHtml(entry.team)}</div>
            <div class="podium-score">${entry.total}pt</div>
        </div>`
    ).join('');
}

// ── 테이블 ──────────────────────────────────────────────────
function renderTable(sortedTeams) {
    const filter = state.currentFilter;
    const tbody = document.getElementById('leaderboard-body');

    if (sortedTeams.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="loading">📭 아직 제출된 점수가 없습니다</td></tr>`;
        return;
    }

    tbody.innerHTML = sortedTeams.map((entry, idx) => {
        const rank = idx + 1;
        const teamScores = state.scores[entry.team] || {};
        const m01 = teamScores['mission-01'];
        const m02 = teamScores['mission-02'];
        const m01Score = getTotalForMission(m01, 'mission-01');
        const m02Score = getTotalForMission(m02, 'mission-02');
        const bonus01 = state.firstCompletion['mission-01'] === entry.team ? CONFIG.FIRST_COMPLETE_BONUS : 0;
        const bonus02 = state.firstCompletion['mission-02'] === entry.team ? CONFIG.FIRST_COMPLETE_BONUS : 0;

        const lastTs = [m01, m02]
            .filter(Boolean)
            .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
        const lastTime = lastTs ? timeAgo(new Date(lastTs.timestamp)) : '-';

        const rankBadgeClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : 'other';

        return `
        <tr class="${rank <= 3 ? 'row-highlight' : ''}">
            <td><span class="rank-badge ${rankBadgeClass}">${rank}</span></td>
            <td>
                <div class="team-name">${escapeHtml(entry.team)}</div>
                ${bonus01 + bonus02 > 0 ? `<div class="team-members">⚡ 보너스 +${bonus01 + bonus02}pt</div>` : ''}
            </td>
            <td>
                ${renderScoreCell(m01Score, bonus01, CONFIG.MAX_SCORES['mission-01'], 'mission01')}
            </td>
            <td>
                ${renderScoreCell(m02Score, bonus02, CONFIG.MAX_SCORES['mission-02'], 'mission02')}
            </td>
            <td><span class="total-score">${entry.total}</span></td>
            <td><span class="time-text">${lastTime}</span></td>
        </tr>`;
    }).join('');
}

function renderScoreCell(score, bonus, max, cssClass) {
    const pct = Math.min(100, Math.round((score / max) * 100));
    return `
        <div class="score-bar">
            <span class="score-value">${score + bonus}</span>
            <span class="score-max">/${max + CONFIG.FIRST_COMPLETE_BONUS}</span>
            <div class="progress">
                <div class="progress-fill ${cssClass}-fill" style="width:${pct}%"></div>
            </div>
        </div>`;
}

// ── 탭 필터 ─────────────────────────────────────────────────
function filterMission(mission) {
    state.currentFilter = mission;
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.mission === mission);
    });
    render();
}

// ── Toast 알림 ───────────────────────────────────────────────
function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
}

// ── 상태 표시 ────────────────────────────────────────────────
function setStatus(status) {
    const dot = document.getElementById('status-dot');
    dot.className = 'dot ' + (status === 'live' ? 'live' : status === 'error' ? 'error' : '');
}

// ── 자동 새로고침 ────────────────────────────────────────────
function startAutoRefresh() {
    refreshTimer = setInterval(loadScores, CONFIG.REFRESH_INTERVAL_MS);
    countdown = CONFIG.REFRESH_INTERVAL_MS / 1000;

    countdownTimer = setInterval(() => {
        countdown--;
        const el = document.getElementById('auto-refresh');
        if (el) {
            if (countdown <= 0) {
                countdown = CONFIG.REFRESH_INTERVAL_MS / 1000;
                el.textContent = '새로고침 중...';
            } else {
                el.textContent = `${countdown}초 후 새로고침`;
            }
        }
    }, 1000);
}

// ── 유틸리티 ────────────────────────────────────────────────
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function timeAgo(date) {
    const diff = Math.floor((Date.now() - date) / 1000);
    if (diff < 60) return `${diff}초 전`;
    if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    return date.toLocaleDateString('ko-KR');
}
