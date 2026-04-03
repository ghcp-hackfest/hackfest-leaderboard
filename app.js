/**
 * GHCP HackFest — Leaderboard App (Multi-Classroom)
 *
 * 여러 Classroom(고객사 이벤트)을 지원하는 실시간 리더보드.
 * Classroom 레지스트리: leaderboard repo의 classrooms.json
 * 점수 파일 경로: scores/{classroom-id}/{team}-{mission-id}.json
 *
 * GitHub Pages: https://[org].github.io/hackfest-leaderboard
 */

// ── 설정 ────────────────────────────────────────────────────
const CONFIG = {
    GITHUB_ORG:          'ghcp-hackfest',
    LEADERBOARD_REPO:    'hackfest-leaderboard',
    SCORES_PATH:         'scores',
    CLASSROOMS_FILE:     'classrooms.json',
    REFRESH_INTERVAL_MS: 30_000,
    FIRST_COMPLETE_BONUS: 30,
};

// ── 상태 ────────────────────────────────────────────────────
let state = {
    classrooms:      [],    // classrooms.json 전체 목록
    classroom:       null,  // 현재 선택된 classroom 객체
    scores:          {},    // { teamName: { 'mission-01': {...}, ... } }
    firstCompletion: {},    // { 'mission-01': 'teamName', ... }
    prevTotals:      {},    // 이전 총점 (변화 감지용)
    currentFilter:   'all',
};
let refreshTimer   = null;
let countdownTimer = null;
let countdown      = CONFIG.REFRESH_INTERVAL_MS / 1000;

// ── 초기화 ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
    await loadClassrooms();
    startAutoRefresh();
});

// ── Classroom 목록 로드 ──────────────────────────────────────
async function loadClassrooms() {
    try {
        const url = `https://api.github.com/repos/${CONFIG.GITHUB_ORG}/${CONFIG.LEADERBOARD_REPO}/contents/${CONFIG.CLASSROOMS_FILE}`;
        const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const meta = await res.json();
        const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(meta.content.replace(/\n/g, '')), c => c.charCodeAt(0))));
        state.classrooms = Array.isArray(data) ? data : [data];
    } catch (err) {
        console.warn('classrooms.json 로드 실패 — 기본값 사용:', err);
        state.classrooms = [];
    }

    renderClassroomNav(state.classrooms);

    // 활성 Classroom 우선 선택
    const active = state.classrooms.find(c => c.status === 'active') || state.classrooms[0] || null;
    if (active) {
        await selectClassroom(active);
    } else {
        renderEmptyState('설정된 Classroom이 없습니다.');
        setStatus('live');
    }
}

// ── Classroom 네비게이션 렌더 ────────────────────────────────
function renderClassroomNav(classrooms) {
    const nav = document.getElementById('classroom-nav');
    if (!nav) return;

    // Classroom이 1개 이하면 네비게이션 숨김
    if (classrooms.length <= 1) {
        nav.style.display = 'none';
        return;
    }
    nav.style.display = 'flex';

    nav.innerHTML = classrooms.map(c => `
        <button class="classroom-tab ${c.status === 'archived' ? 'archived' : ''}"
                data-id="${escapeHtml(c.id)}"
                onclick="selectClassroomById('${escapeHtml(c.id)}')">
            ${c.status === 'archived' ? '📦' : '🎮'} ${escapeHtml(c.name)}
            ${c.status === 'archived' ? '<span class="archived-badge">종료</span>' : ''}
        </button>
    `).join('');
}

async function selectClassroomById(id) {
    const c = state.classrooms.find(x => x.id === id);
    if (c) await selectClassroom(c);
}

async function selectClassroom(classroom) {
    state.classroom       = classroom;
    state.scores          = {};
    state.firstCompletion = {};
    state.prevTotals      = {};
    state.currentFilter   = 'all';

    // 헤더 타이틀 + 상태 배지
    const titleEl = document.getElementById('classroom-title');
    const badgeEl = document.getElementById('classroom-status-badge');
    if (titleEl) titleEl.textContent = classroom.name;
    if (badgeEl) {
        badgeEl.textContent = classroom.status === 'archived' ? '📦 아카이브됨' : '🔴 라이브';
        badgeEl.className   = `status-badge ${classroom.status}`;
    }

    // 탭 활성 표시
    document.querySelectorAll('.classroom-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.id === classroom.id);
    });

    renderMissionTabs(classroom.missions || []);
    renderTableHeader(classroom.missions || []);
    await loadScores();
}

// ── 미션 탭 동적 렌더 ────────────────────────────────────────
function renderMissionTabs(missions) {
    const container = document.getElementById('mission-tabs');
    if (!container) return;

    container.innerHTML =
        `<button class="tab active" data-mission="all" onclick="filterMission('all')">🏆 종합 순위</button>` +
        missions.map((m, i) =>
            `<button class="tab" data-mission="${escapeHtml(m.id)}"
                     onclick="filterMission('${escapeHtml(m.id)}')">Mission #${i + 1}</button>`
        ).join('');
}

// ── 테이블 헤더 동적 렌더 ────────────────────────────────────
function renderTableHeader(missions) {
    const thead = document.getElementById('leaderboard-thead');
    if (!thead) return;

    thead.innerHTML = `<tr>
        <th class="rank-col">순위</th>
        <th class="team-col">팀</th>
        ${missions.map((m, i) => `<th class="score-col">Mission #${i + 1}</th>`).join('')}
        <th class="total-col">총점</th>
        <th class="time-col">최근 제출</th>
    </tr>`;
}

// ── 점수 로드 ────────────────────────────────────────────────
async function loadScores() {
    if (!state.classroom) return;
    setStatus('loading');

    try {
        const apiBase = `https://api.github.com/repos/${CONFIG.GITHUB_ORG}/${CONFIG.LEADERBOARD_REPO}` +
                        `/contents/${CONFIG.SCORES_PATH}/${state.classroom.id}`;
        const res = await fetch(apiBase, { headers: { Accept: 'application/vnd.github+json' } });

        if (!res.ok) {
            if (res.status === 404) { renderEmptyState(); setStatus('live'); return; }
            throw new Error(`GitHub API error: ${res.status}`);
        }

        const files     = await res.json();
        const jsonFiles = files.filter(f => f.name.endsWith('.json'));

        const scoreData = await Promise.all(jsonFiles.map(f => fetchScoreFile(f.download_url)));

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
        if (Object.keys(state.scores).length > 0) render();
    }
}

async function fetchScoreFile(url) {
    try {
        const res = await fetch(url + '?t=' + Date.now());
        if (!res.ok) return null;
        return await res.json();
    } catch { return null; }
}

// ── 최초 완료 팀 계산 ────────────────────────────────────────
function calculateFirstCompletions() {
    const missions = state.classroom?.missions || [];
    missions.forEach(m => {
        let earliest = null, earliestTeam = null;
        Object.entries(state.scores).forEach(([team, teamScores]) => {
            const ms = teamScores[m.id];
            if (!ms || (ms.score || 0) < m.max_score) return;
            const ts = new Date(ms.timestamp);
            if (!earliest || ts < earliest) { earliest = ts; earliestTeam = team; }
        });
        if (earliestTeam) state.firstCompletion[m.id] = earliestTeam;
    });
}

// ── 점수 계산 ────────────────────────────────────────────────
function getTeamTotal(team) {
    const teamScores = state.scores[team] || {};
    let total = 0;
    Object.entries(teamScores).forEach(([missionId, data]) => {
        total += (data.score || 0);
        if (state.firstCompletion[missionId] === team) total += CONFIG.FIRST_COMPLETE_BONUS;
    });
    return total;
}

// ── 변화 감지 (Toast 알림) ───────────────────────────────────
function detectChanges(newScores) {
    Object.entries(newScores).forEach(([team, missions]) => {
        const newTotal  = Object.values(missions).reduce((s, m) => s + (m.score || 0), 0);
        const prevTotal = state.prevTotals[team] || 0;
        if (prevTotal > 0 && newTotal > prevTotal) showToast(`🎉 ${team} +${newTotal - prevTotal}점 획득!`);
        state.prevTotals[team] = newTotal;
    });
}

// ── 렌더링 ──────────────────────────────────────────────────
function render() {
    const teams = getSortedTeams();
    renderPodium(teams.slice(0, 3));
    renderTable(teams);
    renderLegend();
    document.getElementById('last-updated').textContent =
        '최종 업데이트: ' + new Date().toLocaleTimeString('ko-KR');
}

function getSortedTeams() {
    return Object.keys(state.scores)
        .map(team => ({ team, total: getTeamTotal(team) }))
        .sort((a, b) => b.total - a.total || a.team.localeCompare(b.team));
}

function renderEmptyState(msg = '') {
    const colspan = (state.classroom?.missions?.length || 0) + 4;
    document.getElementById('leaderboard-body').innerHTML =
        `<tr><td colspan="${colspan}" class="loading">🏁 ${msg || '이벤트 시작을 기다리는 중...'}</td></tr>`;
}

// ── 포디움 ──────────────────────────────────────────────────
function renderPodium(top3) {
    const crowns    = ['🥇', '🥈', '🥉'];
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
// Mission 별 progress fill 색상 (순환)
const MISSION_COLORS = [
    'linear-gradient(90deg,#58a6ff,#bc8cff)',
    'linear-gradient(90deg,#56d364,#58a6ff)',
    'linear-gradient(90deg,#ffd700,#ff8c00)',
    'linear-gradient(90deg,#bc8cff,#ff79c6)',
    'linear-gradient(90deg,#ff5555,#ffd700)',
    'linear-gradient(90deg,#79c0ff,#56d364)',
    'linear-gradient(90deg,#ff9500,#ff5555)',
    'linear-gradient(90deg,#56d364,#ffd700)',
];

function renderTable(sortedTeams) {
    const missions = state.classroom?.missions || [];
    const tbody    = document.getElementById('leaderboard-body');

    if (sortedTeams.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${missions.length + 4}" class="loading">📭 아직 제출된 점수가 없습니다</td></tr>`;
        return;
    }

    tbody.innerHTML = sortedTeams.map((entry, idx) => {
        const rank       = idx + 1;
        const teamScores = state.scores[entry.team] || {};
        const rankClass  = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : 'other';

        const missionCells = missions.map((m, mi) => {
            const mData  = teamScores[m.id];
            const mScore = mData ? (mData.score || 0) : 0;
            const bonus  = state.firstCompletion[m.id] === entry.team ? CONFIG.FIRST_COMPLETE_BONUS : 0;
            const pct    = Math.min(100, Math.round((mScore / m.max_score) * 100));
            const color  = MISSION_COLORS[mi % MISSION_COLORS.length];
            return `<td>${mData
                ? `<div class="score-bar">
                       <span class="score-value">${mScore + bonus}</span>
                       <span class="score-max">/${m.max_score + CONFIG.FIRST_COMPLETE_BONUS}</span>
                       <div class="progress">
                           <div class="progress-fill" style="width:${pct}%;background:${color}"></div>
                       </div>
                   </div>`
                : '<span class="score-dash">—</span>'
            }</td>`;
        }).join('');

        const allTs    = Object.values(teamScores).map(d => d.timestamp).filter(Boolean);
        const lastTs   = allTs.sort().pop();
        const lastTime = lastTs ? timeAgo(new Date(lastTs)) : '-';
        const totalBonus = missions.reduce(
            (s, m) => s + (state.firstCompletion[m.id] === entry.team ? CONFIG.FIRST_COMPLETE_BONUS : 0), 0
        );

        return `<tr class="${rank <= 3 ? 'row-highlight' : ''}">
            <td><span class="rank-badge ${rankClass}">${rank}</span></td>
            <td>
                <div class="team-name">${escapeHtml(entry.team)}</div>
                ${totalBonus > 0 ? `<div class="team-members">⚡ 보너스 +${totalBonus}pt</div>` : ''}
            </td>
            ${missionCells}
            <td><span class="total-score">${entry.total}</span></td>
            <td><span class="time-text">${lastTime}</span></td>
        </tr>`;
    }).join('');
}

// ── 범례 동적 렌더 ───────────────────────────────────────────
function renderLegend() {
    const missions  = state.classroom?.missions || [];
    const container = document.getElementById('legend-items');
    if (!container) return;

    container.innerHTML = missions.map((m, mi) => {
        const color = MISSION_COLORS[mi % MISSION_COLORS.length];
        return `<div class="legend-item">
            <span class="badge" style="background:rgba(88,166,255,0.15);border:1px solid #58a6ff;color:#fff">
                M${String(mi + 1).padStart(2, '0')}
            </span>
            <span><strong>Mission #${mi + 1}</strong> — 최대 ${m.max_score + CONFIG.FIRST_COMPLETE_BONUS}점
                (기본 ${m.max_score} + 최초완료 보너스 ${CONFIG.FIRST_COMPLETE_BONUS})
            </span>
        </div>`;
    }).join('') +
        `<div class="legend-item">
            <span class="badge bonus">⚡</span>
            <span>각 미션 최초 완료 보너스 <strong>+${CONFIG.FIRST_COMPLETE_BONUS}pt</strong></span>
        </div>`;
}

// ── 탭 필터 ─────────────────────────────────────────────────
function filterMission(mission) {
    state.currentFilter = mission;
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.toggle('active', t.dataset.mission === mission);
    });
}

// ── Toast 알림 ───────────────────────────────────────────────
function showToast(message) {
    const container = document.getElementById('toast-container');
    const toast     = document.createElement('div');
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
    countdown    = CONFIG.REFRESH_INTERVAL_MS / 1000;

    countdownTimer = setInterval(() => {
        countdown--;
        const el = document.getElementById('auto-refresh');
        if (el) {
            if (countdown <= 0) { countdown = CONFIG.REFRESH_INTERVAL_MS / 1000; el.textContent = '새로고침 중...'; }
            else el.textContent = `${countdown}초 후 새로고침`;
        }
    }, 1000);
}

// ── 유틸리티 ────────────────────────────────────────────────
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function timeAgo(date) {
    const diff = Math.floor((Date.now() - date) / 1000);
    if (diff < 60)    return `${diff}초 전`;
    if (diff < 3600)  return `${Math.floor(diff / 60)}분 전`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
    return date.toLocaleDateString('ko-KR');
}
