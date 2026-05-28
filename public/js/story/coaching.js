// Coaching state machine for StoryTeller AI
// Flow: runway → warm-up (3 scenario progressions) → audience frame → /i/

(function () {
  'use strict';

  // Returns [1, random_mid, 10]
  function generateProgression() {
    const mid = 2 + Math.floor(Math.random() * 8);
    return [1, mid, 10];
  }

  // Loads one scenario per tone from Firestore
  async function loadScenarios() {
    const tones = ['joyful', 'sad', 'wildcard'];
    const scenarios = [];
    for (const tone of tones) {
      try {
        const snap = await db
          .collection('warmup_scenarios')
          .where('active', '==', true)
          .where('tone', '==', tone)
          .get();
        if (!snap.empty) {
          const docs = snap.docs;
          const doc = docs[Math.floor(Math.random() * docs.length)];
          scenarios.push({ id: doc.id, ...doc.data() });
        }
      } catch (e) {
        console.warn(`Could not load warmup scenario for tone "${tone}":`, e);
      }
    }
    return scenarios;
  }

  function setCoachingHTML(html) {
    document.getElementById('screen-coaching').innerHTML = html;
  }

  // ── 01 Runway ─────────────────────────────────────────────
  function showRunway(prompt, onContinue) {
    setCoachingHTML(`
      <div class="coaching-screen runway-screen fade-in">
        <p class="step-lbl runway-step">Step 1 of 3</p>
        <h2 class="runway-hl">Before you tell it —</h2>
        <span class="runway-italic">feel it first.</span>
        <p class="runway-body">We'll move through a quick warm-up before the interview. Stories live in the body before they live in words. Wake yours up.</p>
        <div class="runway-card">
          <p class="runway-card-lbl">Your story</p>
          <p class="runway-card-text">"${prompt.text}"</p>
        </div>
        <button class="btn-cta" id="startWarmupBtn">Begin warm-up →</button>
        <p class="runway-hint">About 2 minutes · 3 short exercises</p>
      </div>
    `);
    document.getElementById('startWarmupBtn').addEventListener('click', onContinue);
  }

  // ── 02 Warmup scenarios ───────────────────────────────────
  function runScenario(scenario, scenarioIndex, totalScenarios, onComplete, onSkipAll) {
    const steps = generateProgression();
    let stepIndex = 0;
    let timer = null;
    let finished = false;

    function advance() {
      if (finished) return;
      clearTimeout(timer);
      stepIndex++;
      if (stepIndex >= steps.length) {
        finished = true;
        onComplete();
        return;
      }
      render();
      timer = setTimeout(advance, steps[stepIndex] === 10 ? 5500 : 4200);
    }

    function render() {
      const num = steps[stepIndex];
      const isLast = num === 10;
      const fillDur = isLast ? 5.5 : 4.2;

      // Progress dashes at top
      const dotsHtml = Array.from({ length: totalScenarios }, (_, i) =>
        `<div class="warmup-dot${i < scenarioIndex ? ' done' : i === scenarioIndex ? ' active' : ''}"></div>`
      ).join('');

      // Numbered node track
      const trackHtml = steps.map((step, i) => {
        const cls = i < stepIndex ? ' past' : i === stepIndex ? ' current' : '';
        const conn = i < steps.length - 1
          ? `<div class="warmup-conn${i < stepIndex ? ' done' : ''}"></div>`
          : '';
        return `<div class="warmup-node${cls}">${step}</div>${conn}`;
      }).join('');

      setCoachingHTML(`
        <div class="coaching-screen warmup-screen fade-in" id="warmupStep">
          <div class="warmup-top-bar">
            <div class="warmup-dots">${dotsHtml}</div>
            <span class="warmup-count">${scenarioIndex + 1} of ${totalScenarios}</span>
            <button class="warmup-skip-btn" id="skipBtn">Skip →</button>
          </div>

          <div class="warmup-body">
            <p class="scenario-lbl">Scenario</p>
            <p class="warmup-scenario">${scenario.text}</p>
            ${scenario.subtitle ? `<p class="warmup-sub-text">${scenario.subtitle}</p>` : ''}

            <p class="intensity-lbl">Intensity level</p>
            <div class="warmup-number">${num}</div>
            <div class="warmup-track">${trackHtml}</div>

            ${scenario.coaching ? `<p class="warmup-coaching-quote">"${scenario.coaching}"</p>` : ''}
          </div>

          <div class="warmup-bottom">
            ${isLast
              ? `<button class="btn-continue" id="continueBtn">Continue →</button>`
              : `<div class="warmup-bar">
                   <div class="warmup-fill" style="animation-duration:${fillDur}s"></div>
                 </div>
                 <p class="warmup-tap-hint">Tap to skip ahead</p>`
            }
          </div>
        </div>
      `);

      document.getElementById('skipBtn').addEventListener('click', (e) => {
        e.stopPropagation();
        finished = true;
        clearTimeout(timer);
        if (onSkipAll) onSkipAll();
      });

      document.getElementById('warmupStep').addEventListener('click', () => {
        if (!isLast) advance();
      });

      if (isLast) {
        document.getElementById('continueBtn').addEventListener('click', (e) => {
          e.stopPropagation();
          advance();
        });
      }
    }

    render();
    timer = setTimeout(advance, 4200);
  }

  function runScenarioSequence(scenarios, index, onAllDone) {
    if (index >= scenarios.length) { onAllDone(); return; }
    runScenario(
      scenarios[index], index, scenarios.length,
      () => runScenarioSequence(scenarios, index + 1, onAllDone),
      onAllDone
    );
  }

  // ── 03 Audience frame ─────────────────────────────────────
  function showAudienceFrame(onReady) {
    setCoachingHTML(`
      <div class="coaching-screen audience-screen fade-in">
        <div class="audience-rule"></div>
        <p class="audience-text">Tell your story as if speaking to one person you trust completely.</p>
        <p class="audience-sub">Not a camera. Not an audience.<br>One person.</p>
        <button class="btn-cta" id="readyBtn">I'm ready →</button>
      </div>
    `);
    document.getElementById('readyBtn').addEventListener('click', onReady);
  }

  // ── Entry point ───────────────────────────────────────────
  async function run(prompt, storyId, user) {
    setCoachingHTML(`
      <div class="coaching-screen runway-screen fade-in">
        <p class="runway-body" style="font-style:italic">Preparing your warm-up…</p>
      </div>
    `);

    const scenarios = await loadScenarios();

    if (storyId && scenarios.length > 0) {
      db.collection('stories').doc(storyId).update({
        warmupScenariosShown: scenarios.map(s => s.id),
      }).catch(err => console.warn('Could not update warmupScenariosShown:', err));
    }

    showRunway(prompt, () => {
      runScenarioSequence(scenarios, 0, () => {
        showAudienceFrame(() => {
          const q     = encodeURIComponent(prompt.text);
          const name  = encodeURIComponent((user && (user.displayName || user.email.split('@')[0])) || 'Storyteller');
          const email = encodeURIComponent((user && user.email) || '');
          const sid   = storyId ? `&storyId=${storyId}` : '';
          window.location.href =
            `/i/index.html?interview=story-template-v1&firstQuestion=${q}&name=${name}&email=${email}&video=true&mode=story${sid}`;
        });
      });
    });
  }

  window.Coaching = { run };
})();
