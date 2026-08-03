// Prompt selection UI for StoryTeller AI

(function () {
  'use strict';

  const PAGE_SIZE = 4;

  let allPrompts = [];
  let availablePool = [];   // prompts not yet shown in the current rotation
  let currentSet = [];      // the 4 currently displayed
  let selectedPrompt = null;
  let onChosenCallback = null;

  async function loadPrompts() {
    const snap = await db
      .collection('story_prompts')
      .where('active', '==', true)
      .get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Returns the next PAGE_SIZE prompts, refilling the pool when exhausted
  function getNextSet() {
    if (availablePool.length < PAGE_SIZE) {
      // Refill with everything except what's currently on screen
      const currentIds = new Set(currentSet.map(p => p.id));
      const refill = allPrompts.filter(p => !currentIds.has(p.id));
      availablePool = shuffleArray(refill.length ? refill : allPrompts);
    }
    currentSet = availablePool.splice(0, PAGE_SIZE);
    return currentSet;
  }

  function setBeginEnabled(enabled) {
    document.querySelectorAll('.btn-begin').forEach(b => b.disabled = !enabled);
  }

  function selectCard(prompt, card, grid) {
    selectedPrompt = prompt;
    grid.querySelectorAll('.prompt-card').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    setBeginEnabled(true);
  }

  function renderCards(prompts) {
    const grid = document.getElementById('promptGrid');
    grid.innerHTML = '';
    // Reset selection when the set changes
    selectedPrompt = null;
    setBeginEnabled(false);

    prompts.forEach(prompt => {
      const card = document.createElement('div');
      card.className = 'prompt-card';
      card.dataset.promptId = prompt.id;
      card.innerHTML = `
        <p class="prompt-card-text">${prompt.text}</p>
        <div class="prompt-card-footer">
          <p class="prompt-card-category">${prompt.category || ''}</p>
          <p class="selected-indicator">&#9679;&nbsp;Selected</p>
        </div>
      `;
      card.addEventListener('click', () => selectCard(prompt, card, grid));
      grid.appendChild(card);
    });
  }

  async function init() {
    try {
      allPrompts = await loadPrompts();
    } catch (e) {
      console.error('Failed to load story prompts:', e);
      document.getElementById('promptGrid').innerHTML =
        '<p style="color:#7A6E5B;padding:1rem;font-size:.9375rem;">Could not load prompts. Please refresh.</p>';
      return;
    }

    // Initialise pool and show first set
    availablePool = shuffleArray(allPrompts);
    currentSet = [];
    renderCards(getNextSet());

    function handleShuffle() {
      renderCards(getNextSet());
    }

    function handleBegin() {
      if (selectedPrompt && onChosenCallback) onChosenCallback(selectedPrompt);
    }

    document.querySelectorAll('.btn-surprise').forEach(b => b.addEventListener('click', handleShuffle));
    document.querySelectorAll('.btn-begin').forEach(b => b.addEventListener('click', handleBegin));
  }

  window.PromptSelect = {
    init,
    onChosen(cb) { onChosenCallback = cb; },
  };
})();
