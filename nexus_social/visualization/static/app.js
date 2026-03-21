// NexusSocial - Frontend Application

const PALETTE = [
    '#58a6ff', '#7ee787', '#bc8cff', '#f78166', '#f0883e',
    '#e3b341', '#f778ba', '#56d364', '#79c0ff', '#d2a8ff',
];

let ORG_COLORS = {};
let orgColorIdx = 0;

function getOrgColor(org) {
    if (!ORG_COLORS[org]) {
        ORG_COLORS[org] = PALETTE[orgColorIdx % PALETTE.length];
        orgColorIdx++;
    }
    return ORG_COLORS[org];
}

const ROLE_COLORS = {
    'executive': '#f0883e', 'manager': '#e3b341', 'engineer': '#58a6ff',
    'designer': '#bc8cff', 'analyst': '#7ee787', 'marketing': '#f778ba',
    'sales': '#f0883e', 'hr': '#56d364', 'researcher': '#79c0ff', 'intern': '#8b949e',
};

const SENTIMENT_COLORS = {
    'very_positive': '#2ea043', 'positive': '#56d364', 'neutral': '#8b949e',
    'negative': '#da3633', 'very_negative': '#f85149',
};

const REACTION_EMOJIS = {
    'thumbsup': '\ud83d\udc4d', 'heart': '\u2764\ufe0f', 'fire': '\ud83d\udd25',
    'clap': '\ud83d\udc4f', 'thinking': '\ud83e\udd14', 'rocket': '\ud83d\ude80', '100': '\ud83d\udcaf',
};

const ROLES = ['executive','manager','engineer','designer','analyst','marketing','sales','hr','researcher','intern'];
let personaTemplateNames = [];
let networkData = null;
let orgCounter = 0;

// ===================== Tab switching =====================
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        document.getElementById('tab-' + target).classList.add('active');
        if (target === 'network') renderNetwork();
        if (target === 'analytics') loadAnalytics();
        if (target === 'documents') loadDocuments();
        if (target === 'agents') loadAgents();
        if (target === 'events') loadEvents();
        if (target === 'observer') loadObserver();
        if (target === 'influence') loadInfluence();
        if (target === 'inject') loadInjectionHistory();
        if (target === 'scenarios') loadScenarioBuilder();
    });
});

// ===================== Simulate =====================
async function simulate(ticks) {
    const btns = document.querySelectorAll('.controls button');
    btns.forEach(b => b.disabled = true);
    try {
        const res = await fetch('/api/simulate', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ticks}),
        });
        const data = await res.json();
        document.getElementById('tick-count').textContent = `Tick: ${data.analytics.ticks}`;
        loadFeed();
        const activeTab = document.querySelector('.tab.active').dataset.tab;
        if (activeTab === 'analytics') loadAnalytics();
        if (activeTab === 'network') renderNetwork();
        if (activeTab === 'documents') loadDocuments();
        if (activeTab === 'events') loadEvents();
    } catch (e) {
        console.error('Simulation error:', e);
    } finally {
        btns.forEach(b => b.disabled = false);
    }
}

// ===================== Scenario Builder =====================
async function loadScenarioBuilder() {
    const [scenariosRes, templatesRes] = await Promise.all([
        fetch('/api/scenarios'),
        fetch('/api/persona-templates'),
    ]);
    const scenarios = await scenariosRes.json();
    const templates = await templatesRes.json();
    personaTemplateNames = templates.map(t => t.name);

    // Render scenario cards
    const container = document.getElementById('scenario-cards');
    container.innerHTML = scenarios.map(s => `
        <div class="scenario-card" onclick="loadPreMadeScenario('${s.name}')">
            <h3>${s.name}</h3>
            <p>${s.description}</p>
            <div class="scenario-meta">
                <span class="scenario-stat">${s.org_count} orgs</span>
                <span class="scenario-stat">${s.agent_count} agents</span>
                ${s.tags.map(t => `<span class="scenario-tag">${t}</span>`).join('')}
            </div>
        </div>
    `).join('');

    // Render persona templates
    const ptContainer = document.getElementById('persona-templates');
    ptContainer.innerHTML = templates.map(t => `
        <div class="persona-template-card">
            <h4>${t.name.replace(/_/g, ' ')}</h4>
            <span class="mbti-badge">${t.mbti}</span>
            <span class="scenario-tag">${t.communication_style}</span>
            <span class="scenario-tag">${t.social_media_behavior.replace(/_/g, ' ')}</span>
            <div class="persona-detail">
                ${t.emotional_tendency} &middot; ${t.traits.join(', ')}
            </div>
            ${t.worldview ? `<div class="persona-worldview">"${t.worldview}"</div>` : ''}
        </div>
    `).join('');
}

async function loadPreMadeScenario(name) {
    showLoading('Loading scenario...');
    try {
        const res = await fetch('/api/scenarios/load', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name}),
        });
        const data = await res.json();
        // Reset org colors for new scenario
        ORG_COLORS = {};
        orgColorIdx = 0;
        data.orgs.forEach(o => getOrgColor(o.name));

        document.getElementById('tick-count').textContent = 'Tick: 0';
        hideLoading();
        showToast(`Loaded "${name}": ${data.organizations} orgs, ${data.agents} agents, ${data.teams} teams. Switch to Feed tab and click Simulate!`);

        // Switch to feed
        document.querySelector('[data-tab="feed"]').click();
        loadFeed();
    } catch (e) {
        hideLoading();
        console.error(e);
    }
}

// ===================== Custom Scenario Builder =====================
function addOrgBlock() {
    orgCounter++;
    const id = orgCounter;
    const container = document.getElementById('org-blocks');
    const div = document.createElement('div');
    div.className = 'org-block';
    div.id = `org-${id}`;
    div.innerHTML = `
        <div class="org-block-header">
            <h4>Organization #${id}</h4>
            <button class="btn-danger" onclick="this.closest('.org-block').remove()">Remove</button>
        </div>
        <div class="form-row">
            <label>Name</label>
            <input type="text" class="org-name" placeholder="Company Name">
        </div>
        <div class="form-row">
            <label>Industry</label>
            <input type="text" class="org-industry" placeholder="e.g. Technology, Healthcare">
        </div>
        <div class="form-row">
            <label>Description</label>
            <input type="text" class="org-desc" placeholder="Brief description">
        </div>
        <div class="locations-section">
            <strong style="font-size:12px;color:#8b949e">Locations</strong>
            <button class="btn-small" onclick="addLocationRow(this)">+ Location</button>
            <div class="location-rows"></div>
        </div>
        <div class="teams-section" style="margin-top:12px">
            <strong style="font-size:12px;color:#8b949e">Teams</strong>
            <button class="btn-small" onclick="addTeamBlock(this)">+ Team</button>
            <div class="team-blocks"></div>
        </div>
    `;
    container.appendChild(div);
    addLocationRow(div.querySelector('.locations-section button'));
    addTeamBlock(div.querySelector('.teams-section button'));
}

function addLocationRow(btn) {
    const container = btn.closest('.locations-section').querySelector('.location-rows');
    const div = document.createElement('div');
    div.className = 'location-row';
    div.innerHTML = `
        <input type="text" class="loc-name" placeholder="Office Name">
        <input type="text" class="loc-city" placeholder="City">
        <input type="text" class="loc-country" placeholder="Country">
        <select class="loc-type">
            <option value="headquarters">HQ</option>
            <option value="branch">Branch</option>
            <option value="remote">Remote</option>
            <option value="satellite">Satellite</option>
        </select>
        <button class="btn-danger" onclick="this.parentElement.remove()">x</button>
    `;
    container.appendChild(div);
}

function addTeamBlock(btn) {
    const container = btn.closest('.teams-section').querySelector('.team-blocks');
    const locRows = btn.closest('.org-block').querySelectorAll('.location-row');
    const locOptions = Array.from(locRows).map((r, i) =>
        `<option value="${i}">${r.querySelector('.loc-city').value || `Location ${i+1}`}</option>`
    ).join('');

    const div = document.createElement('div');
    div.className = 'team-block';
    div.innerHTML = `
        <div class="team-block-header">
            <h5>Team</h5>
            <button class="btn-danger" onclick="this.closest('.team-block').remove()">Remove</button>
        </div>
        <div class="form-row">
            <label>Name</label>
            <input type="text" class="team-name" placeholder="Team name" style="font-size:12px">
        </div>
        <div class="form-row">
            <label>Focus</label>
            <input type="text" class="team-focus" placeholder="What does this team do?" style="font-size:12px">
        </div>
        <div class="form-row">
            <label>Location</label>
            <select class="team-loc" style="font-size:12px">${locOptions}</select>
        </div>
        <div>
            <strong style="font-size:11px;color:#8b949e">Agents</strong>
            <button class="btn-small" onclick="addAgentRow(this)">+ Agent</button>
            <div class="agent-rows"></div>
        </div>
    `;
    container.appendChild(div);
    addAgentRow(div.querySelector('button.btn-small'));
}

function addAgentRow(btn) {
    const container = btn.closest('.team-block').querySelector('.agent-rows') ||
                      btn.parentElement.querySelector('.agent-rows');
    const templateOptions = personaTemplateNames.map(n =>
        `<option value="${n}">${n.replace(/_/g, ' ')}</option>`
    ).join('');

    const div = document.createElement('div');
    div.className = 'agent-row';
    div.innerHTML = `
        <input type="text" class="agent-name" placeholder="Agent name">
        <select class="agent-role">
            ${ROLES.map(r => `<option value="${r}">${r}</option>`).join('')}
        </select>
        <select class="agent-persona">
            <option value="">Custom persona</option>
            ${templateOptions}
        </select>
        <button class="btn-danger" onclick="this.parentElement.remove()">x</button>
    `;
    container.appendChild(div);
}

function buildCustomConfig() {
    const config = {
        name: document.getElementById('custom-name').value || 'Custom Scenario',
        description: document.getElementById('custom-desc').value || '',
        category: 'custom',
        organizations: [],
    };

    document.querySelectorAll('.org-block').forEach(orgEl => {
        const org = {
            name: orgEl.querySelector('.org-name').value || 'Unnamed Org',
            industry: orgEl.querySelector('.org-industry').value || 'Technology',
            description: orgEl.querySelector('.org-desc').value || '',
            locations: [],
            teams: [],
        };

        orgEl.querySelectorAll('.location-row').forEach(locEl => {
            org.locations.push({
                name: locEl.querySelector('.loc-name').value || 'Office',
                city: locEl.querySelector('.loc-city').value || 'Unknown',
                country: locEl.querySelector('.loc-country').value || 'Unknown',
                timezone: 'UTC',
                type: locEl.querySelector('.loc-type').value,
            });
        });

        orgEl.querySelectorAll('.team-block').forEach(teamEl => {
            const team = {
                name: teamEl.querySelector('.team-name').value || 'Team',
                focus: teamEl.querySelector('.team-focus').value || 'general',
                location_index: parseInt(teamEl.querySelector('.team-loc').value) || 0,
                agents: [],
            };

            teamEl.querySelectorAll('.agent-row').forEach(agentEl => {
                const agent = {
                    name: agentEl.querySelector('.agent-name').value || 'Agent',
                    role: agentEl.querySelector('.agent-role').value,
                };
                const persona = agentEl.querySelector('.agent-persona').value;
                if (persona) agent.persona_template = persona;
                team.agents.push(agent);
            });

            org.teams.push(team);
        });

        config.organizations.push(org);
    });

    return config;
}

async function loadCustomScenario() {
    const config = buildCustomConfig();
    if (!config.organizations.length) {
        showToast('Add at least one organization first!', true);
        return;
    }

    showLoading('Building custom scenario...');
    try {
        const res = await fetch('/api/scenarios/load', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(config),
        });
        const data = await res.json();
        ORG_COLORS = {};
        orgColorIdx = 0;
        data.orgs.forEach(o => getOrgColor(o.name));

        document.getElementById('tick-count').textContent = 'Tick: 0';
        hideLoading();
        showToast(`Custom scenario loaded: ${data.organizations} orgs, ${data.agents} agents. Switch to Feed and click Simulate!`);
        document.querySelector('[data-tab="feed"]').click();
        loadFeed();
    } catch (e) {
        hideLoading();
        console.error(e);
    }
}

async function exportScenario() {
    const res = await fetch('/api/scenario/export');
    const data = await res.json();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'nexus-scenario.json';
    a.click();
    URL.revokeObjectURL(url);
}

function showToast(msg, isError) {
    let toast = document.getElementById('toast-notification');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast-notification';
        toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:10000;padding:14px 28px;border-radius:8px;font-size:14px;max-width:600px;text-align:center;transition:opacity 0.3s;box-shadow:0 4px 20px rgba(0,0,0,0.5);';
        document.body.appendChild(toast);
    }
    toast.style.background = isError ? '#da3633' : '#238636';
    toast.style.color = '#fff';
    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.display = 'block';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.style.display = 'none', 300); }, 4000);
}

function showLoading(msg) {
    let overlay = document.getElementById('loading-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'loading-overlay';
        overlay.className = 'loading-overlay';
        document.body.appendChild(overlay);
    }
    overlay.textContent = msg || 'Loading...';
    overlay.style.display = 'flex';
}

function hideLoading() {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
}

// ===================== Feed =====================
async function loadFeed() {
    const res = await fetch('/api/feed?limit=50');
    const posts = await res.json();
    const container = document.getElementById('feed-container');

    if (!posts.length) {
        container.innerHTML = '<p class="empty-state">No posts yet. Pick a scenario and click Simulate!</p>';
        return;
    }

    container.innerHTML = posts.map(post => {
        const orgColor = getOrgColor(post.author_org);
        const initials = post.author.split(' ').map(n => n[0]).join('');
        const sentColor = SENTIMENT_COLORS[post.sentiment] || '#8b949e';

        const reactions = Object.entries(post.reactions).map(([emoji, users]) =>
            `<span class="post-stat">${REACTION_EMOJIS[emoji] || emoji} ${users.length}</span>`
        ).join('');

        const comments = post.comments.slice(0, 3).map(c => `
            <div class="comment-card">
                <span class="comment-author" style="color: ${getOrgColor(c.author_org)}">${c.author}</span>
                <span class="comment-content">${c.content}</span>
            </div>
        `).join('');

        const docAttachment = post.shared_document ? `
            <div class="doc-attachment">
                <span class="doc-icon">\ud83d\udcc4</span>
                <div>
                    <div class="doc-title">${post.shared_document.title}</div>
                    <div class="doc-meta">${post.shared_document.doc_type} &middot; ${post.shared_document.views} views</div>
                </div>
            </div>
        ` : '';

        const tags = post.hashtags.map(t => `<span class="tag">#${t}</span>`).join('');
        const mentions = post.mentions.length ? `<span class="post-stat">@ ${post.mentions.join(', ')}</span>` : '';

        return `
            <div class="post-card">
                <div class="post-header">
                    <div class="post-avatar" style="background: ${orgColor}">${initials}</div>
                    <div class="post-author-info">
                        <div class="post-author">${post.author}
                            <span class="sentiment-indicator" style="background: ${sentColor}" title="${post.sentiment}"></span>
                        </div>
                        <div class="post-meta">
                            ${post.author_role} &middot;
                            <span class="org-badge" style="background: ${orgColor}22; color: ${orgColor}">${post.author_org}</span>
                            &middot; ${post.author_team} &middot; ${post.author_location}
                        </div>
                    </div>
                </div>
                <div class="post-content">${post.content}</div>
                ${docAttachment}
                <div class="post-tags">${tags}</div>
                <div class="post-footer">
                    ${reactions}
                    <span class="post-stat">\ud83d\udcac ${post.comment_count}</span>
                    ${mentions}
                </div>
                ${comments}
            </div>
        `;
    }).join('');
}

// ===================== Analytics =====================
async function loadAnalytics() {
    const res = await fetch('/api/analytics');
    const data = await res.json();
    setText('stat-posts', data.total_posts);
    setText('stat-comments', data.total_comments);
    setText('stat-reactions', data.total_reactions || 0);
    setText('stat-dms', data.total_dms);
    setText('stat-docs', data.total_documents);
    setText('stat-cross-org', data.cross_org_interactions);
    renderBarChart('chart-org-activity', data.org_activity || {});
    renderBarChart('chart-location-activity', data.location_activity || {});
    renderBarChart('chart-sentiment', data.sentiment_distribution || {}, SENTIMENT_COLORS);
}

function setText(id, val) {
    const el = document.querySelector(`#${id} .stat-value`);
    if (el) el.textContent = val;
}

function renderBarChart(containerId, data, colorMap) {
    const container = document.getElementById(containerId);
    if (!container) return;
    const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
    const maxVal = Math.max(...entries.map(e => e[1]), 1);
    container.innerHTML = '<div class="bar-chart">' + entries.map(([label, value]) => {
        const color = (colorMap && colorMap[label]) || getOrgColor(label) || '#58a6ff';
        const pct = (value / maxVal * 100).toFixed(1);
        return `
            <div class="bar-row">
                <span class="bar-label">${label}</span>
                <div class="bar-track">
                    <div class="bar-fill" style="width: ${pct}%; background: ${color}">${value}</div>
                </div>
            </div>
        `;
    }).join('') + '</div>';
}

// ===================== Network Graph =====================
async function renderNetwork() {
    const res = await fetch('/api/network');
    networkData = await res.json();
    const canvas = document.getElementById('network-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const colorBy = document.getElementById('graph-color-by').value;

    ctx.clearRect(0, 0, W, H);
    if (!networkData.nodes.length) {
        ctx.fillStyle = '#484f58'; ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Run simulation to see the network graph', W / 2, H / 2);
        return;
    }

    const positions = {}, groups = {};
    networkData.nodes.forEach(node => {
        const key = node[colorBy] || node.org;
        if (!groups[key]) groups[key] = [];
        groups[key].push(node.id);
    });

    const groupKeys = Object.keys(groups);
    const angleStep = (2 * Math.PI) / groupKeys.length;
    groupKeys.forEach((key, gi) => {
        const cx = W / 2 + Math.cos(angleStep * gi) * (W * 0.3);
        const cy = H / 2 + Math.sin(angleStep * gi) * (H * 0.3);
        const members = groups[key];
        members.forEach((id, mi) => {
            const spread = Math.min(80, 200 / members.length);
            const angle = (2 * Math.PI * mi) / members.length;
            positions[id] = {
                x: cx + Math.cos(angle) * spread + (Math.random() - 0.5) * 20,
                y: cy + Math.sin(angle) * spread + (Math.random() - 0.5) * 20,
            };
        });
    });

    networkData.edges.forEach(edge => {
        const src = positions[edge.source], tgt = positions[edge.target];
        if (!src || !tgt) return;
        ctx.beginPath(); ctx.moveTo(src.x, src.y); ctx.lineTo(tgt.x, tgt.y);
        const alpha = Math.min(0.6, 0.1 + edge.weight * 0.05);
        ctx.strokeStyle = `rgba(88, 166, 255, ${alpha})`;
        ctx.lineWidth = Math.min(4, 0.5 + edge.weight * 0.3);
        ctx.stroke();
    });

    const getNodeColor = (node) => {
        if (colorBy === 'org') return getOrgColor(node.org);
        if (colorBy === 'role') return ROLE_COLORS[node.role] || '#8b949e';
        const str = node[colorBy] || '';
        let hash = 0;
        for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
        return `hsl(${Math.abs(hash) % 360}, 60%, 60%)`;
    };

    networkData.nodes.forEach(node => {
        const pos = positions[node.id];
        if (!pos) return;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, 8, 0, 2 * Math.PI);
        ctx.fillStyle = getNodeColor(node); ctx.fill();
        ctx.strokeStyle = '#0f1117'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#c9d1d9'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(node.name.split(' ')[0], pos.x, pos.y + 20);
    });

    const legendItems = [...new Set(networkData.nodes.map(n => n[colorBy] || n.org))];
    ctx.font = '12px sans-serif'; ctx.textAlign = 'left';
    legendItems.forEach((item, i) => {
        const sampleNode = networkData.nodes.find(n => (n[colorBy] || n.org) === item);
        ctx.fillStyle = sampleNode ? getNodeColor(sampleNode) : '#8b949e';
        ctx.fillRect(10, 20 + i * 20, 12, 12);
        ctx.fillStyle = '#c9d1d9'; ctx.fillText(item, 28, 30 + i * 20);
    });
}

// ===================== Documents =====================
async function loadDocuments() {
    const [topicsRes, timelineRes, statsRes] = await Promise.all([
        fetch('/api/documents/topics'), fetch('/api/documents/timeline'), fetch('/api/documents/org-stats'),
    ]);
    const topics = await topicsRes.json(), timeline = await timelineRes.json(), stats = await statsRes.json();

    const topicsEl = document.getElementById('trending-topics');
    topicsEl.innerHTML = topics.length ? topics.map(t => `
        <div class="topic-item">
            <span class="topic-name">${t.topic}</span>
            <span class="topic-count">${t.count} mentions &middot; ${t.docs} docs</span>
        </div>
    `).join('') : '<p class="empty-state" style="padding:20px">No documents yet</p>';

    const timelineEl = document.getElementById('doc-timeline');
    timelineEl.innerHTML = timeline.length ? timeline.slice(-10).reverse().map(d => `
        <div class="timeline-item">
            <div class="timeline-title">${d.title}</div>
            <div class="timeline-meta">${d.doc_type} &middot; by ${d.author} (${d.author_org}) &middot; ${d.views} views</div>
            <div class="timeline-preview">${d.content_preview}</div>
        </div>
    `).join('') : '<p class="empty-state" style="padding:20px">No documents yet</p>';

    const statsEl = document.getElementById('org-doc-stats');
    const statEntries = Object.entries(stats);
    statsEl.innerHTML = statEntries.length ? statEntries.map(([org, s]) => `
        <div style="margin-bottom:12px;">
            <div style="font-weight:600;color:${getOrgColor(org)}">${org}</div>
            <div style="font-size:12px;color:#8b949e">
                ${s.count} documents &middot; Types: ${Object.entries(s.types).map(([t,c]) => `${t}(${c})`).join(', ')}
                &middot; Topics: ${s.top_keywords.join(', ')}
            </div>
        </div>
    `).join('') : '<p class="empty-state" style="padding:20px">No documents yet</p>';

    renderKnowledgeGraph();
}

async function renderKnowledgeGraph() {
    const res = await fetch('/api/documents/knowledge-graph');
    const data = await res.json();
    const canvas = document.getElementById('knowledge-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (!data.nodes.length) {
        ctx.fillStyle = '#484f58'; ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Documents will appear here as they are created', W / 2, H / 2);
        return;
    }

    const positions = {}, typeGroups = {document: [], agent: [], topic: []};
    data.nodes.forEach(n => { if (typeGroups[n.type]) typeGroups[n.type].push(n); });

    const layoutGroup = (nodes, cx, cy, radius) => {
        nodes.forEach((n, i) => {
            const angle = (2 * Math.PI * i) / nodes.length;
            positions[n.id] = {
                x: cx + Math.cos(angle) * radius + (Math.random() - 0.5) * 15,
                y: cy + Math.sin(angle) * radius + (Math.random() - 0.5) * 15,
            };
        });
    };

    layoutGroup(typeGroups.agent, W * 0.2, H * 0.5, Math.min(150, typeGroups.agent.length * 20));
    layoutGroup(typeGroups.document, W * 0.5, H * 0.5, Math.min(180, typeGroups.document.length * 15));
    layoutGroup(typeGroups.topic, W * 0.8, H * 0.5, Math.min(100, typeGroups.topic.length * 25));

    data.edges.forEach(edge => {
        const s = positions[edge.source], t = positions[edge.target];
        if (!s || !t) return;
        ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(t.x, t.y);
        const colors = {authored: '#58a6ff', related: '#bc8cff', topic_link: '#7ee787'};
        ctx.strokeStyle = (colors[edge.type] || '#30363d') + '66';
        ctx.lineWidth = edge.type === 'authored' ? 2 : 1;
        ctx.stroke();
    });

    const TYPE_STYLES = {
        document: {color: '#58a6ff', radius: 7}, agent: {color: '#7ee787', radius: 6}, topic: {color: '#bc8cff', radius: 9},
    };
    data.nodes.forEach(node => {
        const pos = positions[node.id]; if (!pos) return;
        const style = TYPE_STYLES[node.type] || TYPE_STYLES.document;
        ctx.fillStyle = style.color;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, style.radius, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = '#c9d1d9'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
        const label = node.label.length > 20 ? node.label.slice(0, 18) + '..' : node.label;
        ctx.fillText(label, pos.x, pos.y + style.radius + 10);
    });
}

// ===================== Agents =====================
async function loadAgents() {
    const res = await fetch('/api/agents');
    const agents = await res.json();
    const grid = document.getElementById('agents-grid');
    grid.innerHTML = agents.map(a => {
        const orgColor = getOrgColor(a.org);
        const p = a.persona;
        const personaInfo = p ? `
            <div style="font-size:11px;color:#8b949e;margin-top:6px;border-top:1px solid #21262d;padding-top:6px">
                <span class="mbti-badge" style="background:#1f2937;color:#f0883e;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700">${p.mbti}</span>
                ${p.communication_style} &middot; ${p.emotional_tendency} &middot; ${p.social_media_behavior.replace(/_/g,' ')}
                ${p.worldview ? `<div style="color:#7ee787;font-style:italic;margin-top:4px">"${p.worldview}"</div>` : ''}
            </div>
        ` : '';

        return `
            <div class="agent-card" style="border-left: 3px solid ${orgColor}">
                <div class="agent-name">${a.name}</div>
                <div class="agent-role">${a.role}</div>
                <div class="agent-details">
                    <span class="org-badge" style="background: ${orgColor}22; color: ${orgColor}">${a.org}</span>
                    &middot; ${a.team} &middot; ${a.location}<br>
                    Activity: ${'|'.repeat(Math.round(a.activity_level * 10))}${'·'.repeat(10 - Math.round(a.activity_level * 10))}
                    ${a.expertise.length ? '<br>Expertise: ' + a.expertise.join(', ') : ''}
                </div>
                <div class="agent-traits">
                    ${a.traits.map(t => `<span class="trait">${t}</span>`).join('')}
                </div>
                ${personaInfo}
            </div>
        `;
    }).join('');
}

// ===================== Events =====================
async function loadEvents() {
    const res = await fetch('/api/events?limit=100');
    const events = await res.json();
    const log = document.getElementById('events-log');
    if (!events.length) { log.innerHTML = '<p class="empty-state">No events yet</p>'; return; }
    log.innerHTML = events.map(e => `
        <div class="event-item">
            <span class="event-type ${e.type}">${e.type.replace(/_/g, ' ')}</span>
            <span class="event-desc">${e.description}</span>
            <span class="event-time">${new Date(e.timestamp).toLocaleTimeString()}</span>
        </div>
    `).join('');
}

// ===================== Observer =====================
let currentPatternFilter = 'all';

async function loadObserver() {
    const [summaryRes, patternsRes] = await Promise.all([
        fetch('/api/observer/summary'),
        fetch('/api/observer/patterns'),
    ]);
    const summary = await summaryRes.json();
    const patterns = await patternsRes.json();

    // Stats
    const statsEl = document.getElementById('observer-stats');
    statsEl.innerHTML = `
        <div class="observer-stat-card"><div class="val">${summary.total_patterns || 0}</div><div class="lbl">Total Patterns</div></div>
        <div class="observer-stat-card"><div class="val">${summary.ticks_observed || 0}</div><div class="lbl">Ticks Observed</div></div>
        <div class="observer-stat-card"><div class="val">${Object.keys(summary.by_type || {}).length}</div><div class="lbl">Pattern Types</div></div>
    `;

    document.getElementById('pattern-count').textContent = patterns.length;
    renderPatterns(patterns);

    // Wire up filter buttons
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentPatternFilter = btn.dataset.filter;
            renderPatterns(patterns);
        });
    });
}

function renderPatterns(patterns) {
    const filtered = currentPatternFilter === 'all'
        ? patterns
        : patterns.filter(p => p.type === currentPatternFilter);

    const container = document.getElementById('patterns-list');
    if (!filtered.length) {
        container.innerHTML = '<p class="empty-state" style="padding:20px">No patterns detected yet. Run more simulation ticks!</p>';
        return;
    }

    container.innerHTML = filtered.map(p => {
        const severity = p.severity > 0.7 ? 'high' : p.severity > 0.4 ? 'medium' : 'low';
        const agents = (p.agents || []).slice(0, 8);
        return `
            <div class="pattern-card severity-${severity}">
                <div class="pattern-type">${p.type.replace(/_/g, ' ')}</div>
                <div class="pattern-desc">${p.description || ''}</div>
                <div class="pattern-meta">
                    Severity: ${(p.severity * 100).toFixed(0)}%
                    ${p.tick !== undefined ? ` · Tick ${p.tick}` : ''}
                    ${p.org ? ` · ${p.org}` : ''}
                </div>
                ${agents.length ? `<div class="pattern-agents">${agents.map(a => `<span class="tag">${a}</span>`).join('')}</div>` : ''}
            </div>
        `;
    }).join('');
}

// ===================== Narrative Spread =====================
async function trackNarrativeSpread() {
    const keyword = document.getElementById('narrative-keyword').value.trim();
    if (!keyword) { showToast('Enter a keyword to track', true); return; }

    const res = await fetch(`/api/analysis/narrative-spread?keyword=${encodeURIComponent(keyword)}`);
    const data = await res.json();
    const container = document.getElementById('narrative-spread-result');

    if (!data.length) {
        container.innerHTML = `<p class="empty-state" style="padding:15px">No mentions of "${keyword}" found in the simulation.</p>`;
        return;
    }

    container.innerHTML = `
        <div style="font-size:13px;color:#8b949e;margin-bottom:8px">${data.length} mentions of "<strong style="color:#bc8cff">${keyword}</strong>" found</div>
        ${data.map(d => `
            <div class="pattern-card severity-low" style="border-left-color:#bc8cff">
                <div style="font-weight:600;font-size:13px;color:#e1e4e8">${d.agent || d.author || 'Unknown'}
                    <span style="font-size:11px;color:#8b949e"> · Tick ${d.tick || '?'}</span>
                </div>
                <div class="pattern-desc">${d.content || d.text || ''}</div>
            </div>
        `).join('')}
    `;
}

// ===================== WebSocket =====================
let ws = null;

function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws/simulation`);

    ws.onopen = () => {
        document.getElementById('ws-dot').classList.add('connected');
        document.getElementById('ws-label').textContent = 'WebSocket: Connected';
        addWsMessage('Connected to simulation stream');
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.tick !== undefined) {
                document.getElementById('tick-count').textContent = `Tick: ${data.tick}`;
                addWsMessage(`Tick ${data.tick}: ${data.active_agents || 0} active, ${data.new_posts || 0} posts`);
            }
            if (data.patterns) {
                data.patterns.forEach(p => {
                    addWsMessage(`Pattern: ${p.type} — ${p.description}`, '#bc8cff');
                });
            }
        } catch (e) {
            addWsMessage(event.data);
        }
    };

    ws.onclose = () => {
        document.getElementById('ws-dot').classList.remove('connected');
        document.getElementById('ws-label').textContent = 'WebSocket: Disconnected';
        addWsMessage('Disconnected');
    };

    ws.onerror = () => {
        addWsMessage('WebSocket error', '#f85149');
    };
}

function addWsMessage(text, color) {
    const container = document.getElementById('ws-messages');
    const time = new Date().toLocaleTimeString();
    const div = document.createElement('div');
    div.className = 'ws-msg';
    div.innerHTML = `<span class="ws-time">${time}</span><span style="color:${color || '#c9d1d9'}">${text}</span>`;
    container.prepend(div);
    // Keep max 100 messages
    while (container.children.length > 100) container.removeChild(container.lastChild);
}

// ===================== Influence =====================
async function loadInfluence() {
    await Promise.all([loadInfluenceRankings(), loadCommunities(), loadBridgeAgents(), loadStressClusters(), populateAgentDropdown()]);
}

// Populate seed agent dropdown when influence tab loads
async function populateAgentDropdown() {
    const select = document.getElementById('spread-agent');
    if (!select || select.options.length > 1) return;
    try {
        const res = await fetch('/api/agents');
        const agents = await res.json();
        select.innerHTML = agents.map(a =>
            `<option value="${a.id || a.name}">${a.name} (${a.org})</option>`
        ).join('');
    } catch (e) { /* ignore */ }
}

// Threshold slider
document.getElementById('spread-threshold')?.addEventListener('input', function() {
    document.getElementById('spread-threshold-val').textContent = this.value;
});

async function runInfluenceSpread() {
    const agentId = document.getElementById('spread-agent').value;
    const threshold = parseFloat(document.getElementById('spread-threshold').value);
    if (!agentId) { showToast('Select an agent first', true); return; }

    const res = await fetch('/api/graph/influence-spread', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({agent_id: agentId, threshold}),
    });
    const data = await res.json();
    const container = document.getElementById('spread-result');

    if (!data.length) {
        container.innerHTML = '<p class="empty-state" style="padding:15px">No influence spread detected at this threshold.</p>';
        return;
    }

    // Group by round
    const rounds = {};
    data.forEach(d => {
        const r = d.round || 0;
        if (!rounds[r]) rounds[r] = [];
        rounds[r].push(d);
    });

    container.innerHTML = Object.entries(rounds).map(([round, agents]) => `
        <div style="margin-bottom:12px">
            <div style="font-weight:600;font-size:13px;color:#58a6ff;margin-bottom:4px">
                Round ${round} <span style="color:#8b949e;font-weight:400">(${agents.length} agents reached)</span>
            </div>
            <div class="community-agents">
                ${agents.map(a => `<span class="tag" style="background:${getOrgColor(a.org || '')}">${a.agent || a.name}</span>`).join('')}
            </div>
        </div>
    `).join('');
}

async function loadInfluenceRankings() {
    const res = await fetch('/api/graph/influence');
    const data = await res.json();
    const container = document.getElementById('influence-rankings');
    if (!data.length) {
        container.innerHTML = '<p class="empty-state" style="padding:20px">Run simulation first</p>';
        return;
    }
    const maxPR = Math.max(...data.map(d => d.pagerank || 0), 0.001);
    container.innerHTML = data.slice(0, 20).map((d, i) => `
        <div class="influence-row">
            <span class="influence-rank">#${i + 1}</span>
            <span class="influence-name">${d.name}
                <span style="font-size:11px;color:${getOrgColor(d.org)}">${d.org}</span>
            </span>
            <div class="influence-bar">
                <div class="influence-bar-fill" style="width:${((d.pagerank || 0) / maxPR * 100).toFixed(1)}%;background:${getOrgColor(d.org)}"></div>
            </div>
            <span class="influence-score">${(d.pagerank || 0).toFixed(4)}</span>
        </div>
    `).join('');
}

async function loadCommunities() {
    const method = document.getElementById('community-method')?.value || 'louvain';
    const res = await fetch(`/api/graph/communities?method=${method}`);
    const data = await res.json();
    const container = document.getElementById('communities-list');
    if (!data.length) {
        container.innerHTML = '<p class="empty-state" style="padding:20px">No communities detected</p>';
        return;
    }
    container.innerHTML = data.map((c, i) => `
        <div class="community-card">
            <div class="community-header">Community ${i + 1} — ${c.dominant_org || 'Mixed'}</div>
            <div class="community-meta">${c.size} agents · Modularity: ${(c.modularity || 0).toFixed(3)}</div>
            <div class="community-agents">
                ${(c.agents || []).slice(0, 12).map(a => `<span class="tag">${a}</span>`).join('')}
                ${(c.agents || []).length > 12 ? `<span class="tag">+${c.agents.length - 12} more</span>` : ''}
            </div>
        </div>
    `).join('');
}

async function loadBridgeAgents() {
    const res = await fetch('/api/graph/bridges');
    const data = await res.json();
    const container = document.getElementById('bridge-agents');
    if (!data.length) {
        container.innerHTML = '<p class="empty-state" style="padding:20px">No bridge agents found</p>';
        return;
    }
    const maxBC = Math.max(...data.map(d => d.betweenness || 0), 0.001);
    container.innerHTML = data.slice(0, 10).map(d => `
        <div class="influence-row">
            <span class="influence-name">${d.name}
                <span style="font-size:11px;color:${getOrgColor(d.org)}">${d.org}</span>
            </span>
            <div class="influence-bar">
                <div class="influence-bar-fill" style="width:${((d.betweenness || 0) / maxBC * 100).toFixed(1)}%;background:#bc8cff"></div>
            </div>
            <span class="influence-score">${(d.betweenness || 0).toFixed(4)}</span>
        </div>
    `).join('');
}

async function loadStressClusters() {
    const res = await fetch('/api/graph/stress-clusters');
    const data = await res.json();
    const container = document.getElementById('stress-clusters');
    if (!data.length) {
        container.innerHTML = '<p class="empty-state" style="padding:20px">No stress clusters</p>';
        return;
    }
    container.innerHTML = data.map(c => `
        <div class="community-card" style="border-left:3px solid #f85149">
            <div class="community-header" style="color:#f85149">Stress Cluster — ${c.dominant_org || 'Mixed'}</div>
            <div class="community-meta">
                ${c.size} agents · Avg stress: ${(c.avg_stress || 0).toFixed(2)} · Avg morale: ${(c.avg_morale || 0).toFixed(2)}
            </div>
            <div class="community-agents">
                ${(c.agents || []).slice(0, 8).map(a => `<span class="tag">${a}</span>`).join('')}
            </div>
        </div>
    `).join('');
}

// ===================== Injection =====================
function fillInjection(type, desc) {
    document.getElementById('inject-type').value = type;
    document.getElementById('inject-desc').value = desc;
}

async function submitInjection() {
    const desc = document.getElementById('inject-desc').value;
    if (!desc) { showToast('Enter an event description', true); return; }

    const body = {
        type: document.getElementById('inject-type').value,
        description: desc,
    };
    const orgs = document.getElementById('inject-orgs').value.trim();
    if (orgs) body.target_orgs = orgs.split(',').map(s => s.trim());
    const agents = document.getElementById('inject-agents').value.trim();
    if (agents) body.target_agents = agents.split(',').map(s => s.trim());

    try {
        const res = await fetch('/api/inject', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
        });
        const data = await res.json();
        showToast(`Injected: ${body.type} — ${data.effects?.length || 0} effects applied`);
        document.getElementById('inject-desc').value = '';
        loadInjectionHistory();
    } catch (e) {
        showToast('Injection failed: ' + e.message, true);
    }
}

async function loadInjectionHistory() {
    const res = await fetch('/api/inject/history');
    const history = await res.json();
    const container = document.getElementById('injection-history');
    if (!history.length) {
        container.innerHTML = '<p class="empty-state" style="padding:20px">No injections yet</p>';
        return;
    }
    container.innerHTML = history.map(h => `
        <div class="injection-card">
            <div class="injection-type">${h.type}</div>
            <div class="injection-desc">${h.description}</div>
            <div class="injection-meta">Tick ${h.tick || '?'} · ${h.effects?.length || 0} effects</div>
            ${h.effects?.length ? `<div class="injection-effects">${h.effects.slice(0, 3).map(e => e.description || e.type).join(' · ')}</div>` : ''}
        </div>
    `).join('');
}

// ===================== Init =====================
loadFeed();
