// NexusSocial - Frontend Application

const ORG_COLORS = {
    'NovaTech': '#58a6ff',
    'HelixBio': '#7ee787',
    'PrismCreative': '#bc8cff',
};

const ROLE_COLORS = {
    'executive': '#f0883e',
    'manager': '#e3b341',
    'engineer': '#58a6ff',
    'designer': '#bc8cff',
    'analyst': '#7ee787',
    'marketing': '#f778ba',
    'sales': '#f0883e',
    'hr': '#56d364',
    'researcher': '#79c0ff',
    'intern': '#8b949e',
};

const SENTIMENT_COLORS = {
    'very_positive': '#2ea043',
    'positive': '#56d364',
    'neutral': '#8b949e',
    'negative': '#da3633',
    'very_negative': '#f85149',
};

const REACTION_EMOJIS = {
    'thumbsup': '\ud83d\udc4d',
    'heart': '\u2764\ufe0f',
    'fire': '\ud83d\udd25',
    'clap': '\ud83d\udc4f',
    'thinking': '\ud83e\udd14',
    'rocket': '\ud83d\ude80',
    '100': '\ud83d\udcaf',
};

let networkData = null;

// Tab switching
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
    });
});

// Simulate
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

        // Refresh active tab
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

// Feed
async function loadFeed() {
    const res = await fetch('/api/feed?limit=50');
    const posts = await res.json();
    const container = document.getElementById('feed-container');

    if (!posts.length) {
        container.innerHTML = '<p class="empty-state">No posts yet. Click "Simulate" to start!</p>';
        return;
    }

    container.innerHTML = posts.map(post => {
        const orgColor = ORG_COLORS[post.author_org] || '#8b949e';
        const initials = post.author.split(' ').map(n => n[0]).join('');
        const sentColor = SENTIMENT_COLORS[post.sentiment] || '#8b949e';

        const reactions = Object.entries(post.reactions).map(([emoji, users]) =>
            `<span class="post-stat">${REACTION_EMOJIS[emoji] || emoji} ${users.length}</span>`
        ).join('');

        const comments = post.comments.slice(0, 3).map(c => `
            <div class="comment-card">
                <span class="comment-author" style="color: ${ORG_COLORS[c.author_org] || '#8b949e'}">${c.author}</span>
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

// Analytics
async function loadAnalytics() {
    const res = await fetch('/api/analytics');
    const data = await res.json();

    setText('stat-posts', data.total_posts);
    setText('stat-comments', data.total_comments);
    setText('stat-reactions', data.total_reactions || 0);
    setText('stat-dms', data.total_dms);
    setText('stat-docs', data.total_documents);
    setText('stat-cross-org', data.cross_org_interactions);

    renderBarChart('chart-org-activity', data.org_activity || {}, ORG_COLORS);
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
        const color = (colorMap && colorMap[label]) || '#58a6ff';
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

// Network Graph
async function renderNetwork() {
    const res = await fetch('/api/network');
    networkData = await res.json();

    const canvas = document.getElementById('network-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const colorBy = document.getElementById('graph-color-by').value;

    ctx.clearRect(0, 0, W, H);

    if (!networkData.nodes.length) {
        ctx.fillStyle = '#484f58';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Run simulation to see the network graph', W / 2, H / 2);
        return;
    }

    // Layout using force-directed-like positioning
    const positions = {};
    const groups = {};

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

    // Draw edges
    networkData.edges.forEach(edge => {
        const src = positions[edge.source];
        const tgt = positions[edge.target];
        if (!src || !tgt) return;

        ctx.beginPath();
        ctx.moveTo(src.x, src.y);
        ctx.lineTo(tgt.x, tgt.y);
        const alpha = Math.min(0.6, 0.1 + edge.weight * 0.05);
        ctx.strokeStyle = `rgba(88, 166, 255, ${alpha})`;
        ctx.lineWidth = Math.min(4, 0.5 + edge.weight * 0.3);
        ctx.stroke();
    });

    // Draw nodes
    const nodeMap = {};
    networkData.nodes.forEach(n => nodeMap[n.id] = n);

    const getNodeColor = (node) => {
        if (colorBy === 'org') return ORG_COLORS[node.org] || '#8b949e';
        if (colorBy === 'role') return ROLE_COLORS[node.role] || '#8b949e';
        // For team/location, hash to color
        const str = node[colorBy] || '';
        let hash = 0;
        for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
        const hue = Math.abs(hash) % 360;
        return `hsl(${hue}, 60%, 60%)`;
    };

    networkData.nodes.forEach(node => {
        const pos = positions[node.id];
        if (!pos) return;
        const color = getNodeColor(node);
        const radius = 8;

        ctx.beginPath();
        ctx.arc(pos.x, pos.y, radius, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#0f1117';
        ctx.lineWidth = 2;
        ctx.stroke();

        // Label
        ctx.fillStyle = '#c9d1d9';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(node.name.split(' ')[0], pos.x, pos.y + radius + 12);
    });

    // Legend
    const legendItems = [...new Set(networkData.nodes.map(n => n[colorBy] || n.org))];
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'left';
    legendItems.forEach((item, i) => {
        const sampleNode = networkData.nodes.find(n => (n[colorBy] || n.org) === item);
        const color = sampleNode ? getNodeColor(sampleNode) : '#8b949e';
        const y = 20 + i * 20;
        ctx.fillStyle = color;
        ctx.fillRect(10, y - 5, 12, 12);
        ctx.fillStyle = '#c9d1d9';
        ctx.fillText(item, 28, y + 5);
    });
}

// Documents
async function loadDocuments() {
    const [topicsRes, timelineRes, statsRes] = await Promise.all([
        fetch('/api/documents/topics'),
        fetch('/api/documents/timeline'),
        fetch('/api/documents/org-stats'),
    ]);

    const topics = await topicsRes.json();
    const timeline = await timelineRes.json();
    const stats = await statsRes.json();

    // Topics
    const topicsEl = document.getElementById('trending-topics');
    if (topics.length) {
        topicsEl.innerHTML = topics.map(t => `
            <div class="topic-item">
                <span class="topic-name">${t.topic}</span>
                <span class="topic-count">${t.count} mentions &middot; ${t.docs} docs</span>
            </div>
        `).join('');
    } else {
        topicsEl.innerHTML = '<p class="empty-state" style="padding: 20px">No documents yet</p>';
    }

    // Timeline
    const timelineEl = document.getElementById('doc-timeline');
    if (timeline.length) {
        timelineEl.innerHTML = timeline.slice(-10).reverse().map(d => `
            <div class="timeline-item">
                <div class="timeline-title">${d.title}</div>
                <div class="timeline-meta">${d.doc_type} &middot; by ${d.author} (${d.author_org}) &middot; ${d.views} views</div>
                <div class="timeline-preview">${d.content_preview}</div>
            </div>
        `).join('');
    } else {
        timelineEl.innerHTML = '<p class="empty-state" style="padding: 20px">No documents yet</p>';
    }

    // Org stats
    const statsEl = document.getElementById('org-doc-stats');
    const statEntries = Object.entries(stats);
    if (statEntries.length) {
        statsEl.innerHTML = statEntries.map(([org, s]) => `
            <div style="margin-bottom: 12px;">
                <div style="font-weight: 600; color: ${ORG_COLORS[org] || '#c9d1d9'}">${org}</div>
                <div style="font-size: 12px; color: #8b949e">
                    ${s.count} documents &middot;
                    Types: ${Object.entries(s.types).map(([t,c]) => `${t}(${c})`).join(', ')} &middot;
                    Topics: ${s.top_keywords.join(', ')}
                </div>
            </div>
        `).join('');
    } else {
        statsEl.innerHTML = '<p class="empty-state" style="padding: 20px">No documents yet</p>';
    }

    // Knowledge graph
    renderKnowledgeGraph();
}

async function renderKnowledgeGraph() {
    const res = await fetch('/api/documents/knowledge-graph');
    const data = await res.json();

    const canvas = document.getElementById('knowledge-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);

    if (!data.nodes.length) {
        ctx.fillStyle = '#484f58';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Documents will appear here as they are created', W / 2, H / 2);
        return;
    }

    const positions = {};
    const typeGroups = {document: [], agent: [], topic: []};
    data.nodes.forEach(n => {
        if (typeGroups[n.type]) typeGroups[n.type].push(n);
    });

    // Layout: documents center, agents left, topics right
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

    // Edges
    data.edges.forEach(edge => {
        const s = positions[edge.source];
        const t = positions[edge.target];
        if (!s || !t) return;

        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        const colors = {authored: '#58a6ff', related: '#bc8cff', topic_link: '#7ee787'};
        ctx.strokeStyle = (colors[edge.type] || '#30363d') + '66';
        ctx.lineWidth = edge.type === 'authored' ? 2 : 1;
        ctx.stroke();
    });

    // Nodes
    const TYPE_STYLES = {
        document: {color: '#58a6ff', radius: 7, shape: 'rect'},
        agent: {color: '#7ee787', radius: 6, shape: 'circle'},
        topic: {color: '#bc8cff', radius: 9, shape: 'diamond'},
    };

    data.nodes.forEach(node => {
        const pos = positions[node.id];
        if (!pos) return;
        const style = TYPE_STYLES[node.type] || TYPE_STYLES.document;

        ctx.fillStyle = style.color;
        if (style.shape === 'circle') {
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, style.radius, 0, 2 * Math.PI);
            ctx.fill();
        } else if (style.shape === 'rect') {
            ctx.fillRect(pos.x - style.radius, pos.y - style.radius, style.radius * 2, style.radius * 2);
        } else {
            ctx.beginPath();
            ctx.moveTo(pos.x, pos.y - style.radius);
            ctx.lineTo(pos.x + style.radius, pos.y);
            ctx.lineTo(pos.x, pos.y + style.radius);
            ctx.lineTo(pos.x - style.radius, pos.y);
            ctx.closePath();
            ctx.fill();
        }

        ctx.fillStyle = '#c9d1d9';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        const label = node.label.length > 20 ? node.label.slice(0, 18) + '..' : node.label;
        ctx.fillText(label, pos.x, pos.y + style.radius + 10);
    });

    // Legend
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'left';
    [['Agent', '#7ee787', 'circle'], ['Document', '#58a6ff', 'rect'], ['Topic', '#bc8cff', 'diamond']].forEach(([lbl, clr], i) => {
        ctx.fillStyle = clr;
        ctx.fillRect(10, 10 + i * 18, 10, 10);
        ctx.fillStyle = '#c9d1d9';
        ctx.fillText(lbl, 26, 19 + i * 18);
    });
}

// Agents
async function loadAgents() {
    const res = await fetch('/api/agents');
    const agents = await res.json();
    const grid = document.getElementById('agents-grid');

    grid.innerHTML = agents.map(a => {
        const orgColor = ORG_COLORS[a.org] || '#8b949e';
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
            </div>
        `;
    }).join('');
}

// Events
async function loadEvents() {
    const res = await fetch('/api/events?limit=100');
    const events = await res.json();
    const log = document.getElementById('events-log');

    if (!events.length) {
        log.innerHTML = '<p class="empty-state">No events yet</p>';
        return;
    }

    log.innerHTML = events.map(e => `
        <div class="event-item">
            <span class="event-type ${e.type}">${e.type.replace(/_/g, ' ')}</span>
            <span class="event-desc">${e.description}</span>
            <span class="event-time">${new Date(e.timestamp).toLocaleTimeString()}</span>
        </div>
    `).join('');
}

// Initial load
loadFeed();
