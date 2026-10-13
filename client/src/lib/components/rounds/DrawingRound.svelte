<script lang="ts">
  import { onMount } from 'svelte';
  import { drawingImage } from '../../GameState';
  import {
    SendDrawingAction,
    ActionEnum,
    type EndRoundAction,
  } from '@shared/actions';
  import ClientWebsocket from '../../ClientWebsocket';
  import {
    roundStore,
    endCurrentRound,
    currentServerRound,
  } from '../../stores/roundStore';
  import { LayerMode } from '../../types/LayerMode';
  import type { PenParams } from '../../types/PenParams';
  import Round from '../Round.svelte';
  import { MAX_NAME_LENGTH, sanitizeNameDraftInput } from '@shared/inputValidation';

  let {
    pen: initialPen,
    showWidget = false,
    layerMode = LayerMode.BehindLayer,
  }: {
    pen: PenParams;
    showWidget?: boolean;
    layerMode?: LayerMode;
  } = $props();

  let submitted = $state(false);
  // Server round this canvas belongs to (stamped on submissions so a slow
  // submit can't be counted toward the next round).
  const myRound = currentServerRound();

  function sendDrawing(imageData: string) {
    drawingImage.set(imageData);
    ClientWebsocket.sendAction(new SendDrawingAction(imageData, myRound));
  }

  /**
   * Synchronous best-effort save when the tab is closing/refreshing. Uses the
   * already-rendered layer canvases (no async image loads, which never finish
   * during unload). The server keeps it as this player's work but does not mark
   * them done, so after a refresh they continue drawing from here.
   */
  function autosave() {
    if (submitted || !canvas) return;
    try {
      const out = document.createElement('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const ctx = out.getContext('2d');
      if (!ctx) return;
      if (layerMode === LayerMode.FrontLayer && backgroundCanvas) {
        ctx.drawImage(backgroundCanvas, 0, 0, 520, 520);
      }
      ctx.drawImage(canvas, 0, 0);
      if (layerMode === LayerMode.BehindLayer && overlayCanvas) {
        ctx.drawImage(overlayCanvas, 0, 0, 520, 520);
      }
      ClientWebsocket.sendAction(
        new SendDrawingAction(out.toDataURL(), myRound, true),
      );
    } catch (err) {
      console.error('autosave failed', err);
    }
  }
  let canvas = $state<HTMLCanvasElement>();
  let overlayCanvas = $state<HTMLCanvasElement>();
  let backgroundCanvas = $state<HTMLCanvasElement>();
  let context = $state<CanvasRenderingContext2D | null>(null);
  let shouldDraw = $state(false);
  let timer = $state(0);
  let randTimerMod = $state(5);

  let pen = $state<PenParams>({ ...initialPen });
  const isTextPen = !!pen.textFont;

  let history = $state<ImageData[]>([]);
  let redoStack = $state<ImageData[]>([]);

  const isUndoRedoEnabled = !pen.scribble && !pen.textFont;

  const COLORS = [
  // Row 1: Reds to Oranges
  '#A30000', // dark red
  '#db2828', // red
  '#ff6f61', // coral
  '#f2711c', // orange
  '#ff8c00', // dark orange
  '#fbbd08', // yellow
  
  // Row 2: Greens to Blues
  '#006400', // dark green
  '#21ba45', // green
  '#84cc16', // lime
  '#38bdf8', // sky blue
  '#2185d0', // blue
  '#07409C', // navy
  
  // Row 3: Purples to Neutrals
  '#6435c9', // violet
  '#a333c8', // purple
  '#e03997', // pink
  '#00b5ad', // teal
  '#808080', // grey
  '#a16207', // brown
];

  function prepareContext() {
    if (!canvas) return;

    // Set canvas to fixed 520x520 for consistent sizing across devices
    canvas.width = 520;
    // Adds whitespace for text if pen is adding writing to the bottom
    canvas.height = isTextPen ? 545 : 520;

    context = canvas.getContext('2d');

    // Set up overlay canvas based on layer mode
    if (layerMode === LayerMode.BehindLayer && overlayCanvas) {
      overlayCanvas.width = 520;
      overlayCanvas.height = 520;

      // Load and draw the overlay image immediately
      if ($drawingImage) {
        const overlayCtx = overlayCanvas.getContext('2d');
        const overlayImage = new Image();
        overlayImage.onload = () => {
          overlayCtx?.drawImage(overlayImage, 0, 0, 520, 520);
        };
        overlayImage.src = $drawingImage;
      }
    } else if (layerMode === LayerMode.FrontLayer && backgroundCanvas) {
      // In FrontLayer mode, store the background image separately
      backgroundCanvas.width = 520;
      backgroundCanvas.height = 520;

      if ($drawingImage) {
        const bgCtx = backgroundCanvas.getContext('2d');
        const bgImage = new Image();
        bgImage.onload = () => {
          bgCtx?.drawImage(bgImage, 0, 0, 520, 520);
        };
        bgImage.src = $drawingImage;
      }
    }

    setLineProperties();
  }

  async function setLineProperties() {
    if (!context) return;

    // Text / name round
    if (pen.textFont) {
      try {
        await document.fonts.load(
          `${pen.textFont.size}px '${pen.textFont.name}'`,
        );
        context.font = `${pen.textFont.size}px '${pen.textFont.name}'`;
      } catch {
        context.font = `${pen.textFont.size}px sans-serif`;
      }
      return;
    }

    // Drawing rounds
    context.strokeStyle = pen.strokeStyle;
    context.lineWidth = pen.lineWidth;
    context.lineJoin = pen.lineJoin
    context.lineCap = pen.lineCap;
  }

  function getCanvasCoordinates(clientX: number, clientY: number) {
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (clientX - rect.left - canvas.clientLeft) * scaleX;
    const y = (clientY - rect.top - canvas.clientTop) * scaleY;
    return { x, y };
  }

  function handleMouseDown(event: MouseEvent) {
    if (isTextPen || event.button !== 0) return;
    if (!context || !canvas) return;

    if (isUndoRedoEnabled) {
      saveState();
    }

    shouldDraw = true;
    setLineProperties();

    context.beginPath();
    const { x, y } = getCanvasCoordinates(event.clientX, event.clientY);
    context.moveTo(x, y);
  }

  function handleMouseUp(event: MouseEvent) {
    if (event.button === 0) {
      shouldDraw = false;
    }
  }

  function handleMouseMove(event: MouseEvent) {
    if (!shouldDraw || !context || !canvas) return;

    const { x, y } = getCanvasCoordinates(event.clientX, event.clientY);

    context.lineTo(x, y);
    context.stroke();

    if (pen.scribble) {
      scribbleStutter(x, y);
    }
  }

  function handleTouchStart(event: TouchEvent) {
    if (isTextPen) return;
    if (!context || !canvas) return;

    if (isUndoRedoEnabled) {
      saveState();
    }

    event.preventDefault();
    shouldDraw = true;
    setLineProperties();

    const touch = event.touches[0];
    const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);
    context.beginPath();
    context.moveTo(x, y);
  }

  function handleTouchMove(event: TouchEvent) {
    if (!shouldDraw || !context || !canvas) return;

    event.preventDefault();
    const touch = event.touches[0];
    const { x, y } = getCanvasCoordinates(touch.clientX, touch.clientY);

    context.lineTo(x, y);
    context.stroke();

    if (pen.scribble) {
      scribbleStutter(x, y);
    }
  }

  function handleTouchEnd(event: TouchEvent) {
    event.preventDefault();
    shouldDraw = false;
  }

  function handlePenSizeChange(event: Event) {
    const input = event.target as HTMLInputElement;
    pen.lineWidth = Number(input.value);
    setLineProperties();
  }

  // Picks up the pen and puts it down sporadically with a random opacity each time
  // This mimics the jagged look of graphite on paper
  function scribbleStutter(x: number, y: number) {
    if (!context) return;

    timer++;

    if (timer % randTimerMod === 0) {
      randTimerMod = Math.floor(Math.random() * 4) + 1;
      context.strokeStyle = `rgb(0 0 0 / ${Math.random() * 0.04 + 0.01})`;
      context.beginPath();
      context.moveTo(x, y);
      setTimeout(() => (shouldDraw = true), 0);
    }
  }

  function handleTextInput(event: Event) {
    if (!context || !canvas || !isTextPen) return;

    const input = event.target as HTMLInputElement;
    const text = sanitizeNameDraftInput(input.value);
    if (input.value !== text) {
      input.value = text;
    }

    context.clearRect(0, 0, canvas.width, canvas.height);

    context.textAlign = 'center';
    context.textBaseline = 'bottom';

    const xPosition = canvas.width / 2;
    const yPosition = canvas.height - 10;
    context.fillText(text, xPosition, yPosition);
  }

  function handleColorChange(color: string) {
    pen.strokeStyle = color;
    setLineProperties();
  }

  async function handleRoundEnd() {
    if (submitted || !canvas || !context) return;
    submitted = true;

    const canvasRef = canvas; // Capture canvas reference

    // If FrontLayer mode, composite the background image behind before sending
    if (
      layerMode === LayerMode.FrontLayer &&
      backgroundCanvas &&
      $drawingImage
    ) {
      // Return a promise that resolves when the background is composited
      return new Promise<void>((resolve) => {
        const bgImage = new Image();
        bgImage.onload = () => {
          if (!context) {
            resolve();
            return;
          }
          // Draw the background image behind the text/drawing
          context.globalCompositeOperation = 'destination-over';
          context.drawImage(bgImage, 0, 0, 520, 520);
          // Reset composite operation
          context.globalCompositeOperation = 'source-over';

          sendDrawing(canvasRef.toDataURL());
          resolve();
        };
        bgImage.onerror = () => {
          // If image fails to load, send what we have
          sendDrawing(canvasRef.toDataURL());
          resolve();
        };
        bgImage.src = $drawingImage;
      });
    } else if (layerMode === LayerMode.BehindLayer && $drawingImage) {
      // For BehindLayer, draw the stored image on top before sending
      return new Promise<void>((resolve) => {
        const overlayImage = new Image();
        overlayImage.onload = () => {
          if (!context) {
            resolve();
            return;
          }
          context.drawImage(overlayImage, 0, 0, 520, 520);
          sendDrawing(canvasRef.toDataURL());
          resolve();
        };
        overlayImage.onerror = () => {
          // If image fails to load, send what we have
          sendDrawing(canvasRef.toDataURL());
          resolve();
        };
        overlayImage.src = $drawingImage;
      });
    } else {
      // Fallback: just send the canvas as-is
      sendDrawing(canvasRef.toDataURL());
    }
  }

  $effect(() => {
    if (!$drawingImage) return;

    const image = new Image();
    image.onload = () => {
      if (layerMode === LayerMode.BehindLayer && overlayCanvas) {
        const overlayCtx = overlayCanvas.getContext('2d');
        if (overlayCtx) {
          overlayCtx.clearRect(0, 0, 520, 520);
          overlayCtx.drawImage(image, 0, 0, 520, 520);
        }
      } else if (layerMode === LayerMode.FrontLayer && backgroundCanvas) {
        const bgCtx = backgroundCanvas.getContext('2d');
        if (bgCtx) {
          bgCtx.clearRect(0, 0, 520, 520);
          bgCtx.drawImage(image, 0, 0, 520, 520);
        }
      }
    };
    image.src = $drawingImage;
  });

  onMount(() => {
    prepareContext();
    if (isUndoRedoEnabled && context && canvas) {
      const initial = context.getImageData(0, 0, canvas.width, canvas.height);
      history = [initial];
    }

    window.addEventListener('beforeunload', autosave);

    const removeServerEndRoundListener = ClientWebsocket.addActionListener(
      ActionEnum.END_ROUND,
      async (action: EndRoundAction) => {
        const round = action.payload.roundNumber;
        if (round !== undefined && round !== myRound) return;
        await handleRoundEnd();
      },
    );

    // Submit slightly before the timer hits zero so the drawing beats END_ROUND
    const timerId = setTimeout(async () => {
      await handleRoundEnd();
      endCurrentRound(undefined, myRound);
    }, Math.max(0, $roundStore.timeLeft * 1000 - 250));

    if (!canvas) return;

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('touchstart', handleTouchStart);
    canvas.addEventListener('touchmove', handleTouchMove);
    canvas.addEventListener('touchend', handleTouchEnd);

    return () => {
      removeServerEndRoundListener();
      window.removeEventListener('beforeunload', autosave);
      clearTimeout(timerId);
      if (!canvas) return;
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
    };
  });

  // For Undo/Redo Button
  function saveState() {
    if (!context || !canvas) return;

    const snapshot = context.getImageData(0, 0, canvas.width, canvas.height);
    history = [...history, snapshot];

    // Once you draw again, redo history is cleared
    redoStack = [];
  }

  function restoreState(imageData: ImageData) {
    if (!context) return;
    context.putImageData(imageData, 0, 0);
  }

  function handleUndo() {
    if (!context || history.length === 0) return;

    const current = context.getImageData(0, 0, canvas!.width, canvas!.height);

    const previous = history[history.length - 1];
    history = history.slice(0, -1);

    redoStack = [...redoStack, current];

    restoreState(previous);
  }

  function handleRedo() {
    if (!context || redoStack.length === 0) return;

    const current = context.getImageData(0, 0, canvas!.width, canvas!.height);

    const next = redoStack[redoStack.length - 1];
    redoStack = redoStack.slice(0, -1);

    history = [...history, current];

    restoreState(next);
  }
</script>

<Round onRoundEnd={handleRoundEnd}>
  <div class="drawing-container">
    <div
      class="canvas-wrapper"
      style={`--canvas-height: ${isTextPen ? 545 : 520}px;`}
    >
      <div class="white-bg"><!-- --></div>
      {#if layerMode === LayerMode.FrontLayer}
        <canvas bind:this={backgroundCanvas} class="background-canvas"
          ><!-- --></canvas
        >
      {/if}
      <canvas bind:this={canvas} class="drawing-canvas"><!-- --></canvas>
      {#if layerMode === LayerMode.BehindLayer}
        <canvas bind:this={overlayCanvas} class="overlay-canvas"
          ><!-- --></canvas
        >
      {/if}
    </div>

    {#if showWidget}
      <div class="widget-container">
      <!-- COLOR ROUND -->
        {#if pen.strokeStyle}
          <!-- ROW 1: COLORS -->
          <div class="color-picker">
            {#each COLORS as color}
              <input
                type="radio"
                id={color}
                name="color"
                value={color}
                onchange={() => handleColorChange(color)}
              />
              <label for={color} style="background-color: {color}" />
            {/each}
          </div>
          <div class="custom-color">
            <input
              type="color"
              oninput={(e) => handleColorChange((e.target as HTMLInputElement).value)}
            />
          </div>

          <!-- ROW 2: SLIDER + UNDO/REDO -->
          <div class="drawing-controls-row">
            <!-- Pen size control -->
            <div class="pen-size-control">
              <input
                type="range"
                min="4"
                max="40"
                step="1"
                value={pen.lineWidth}
                oninput={handlePenSizeChange}
              />
              <div class="pen-preview">
                <span
                  class="pen-dot"
                  style="width: {pen.lineWidth}px; height: {pen.lineWidth}px; background-color: {pen.strokeStyle};"
                ></span>
              </div>
            </div>

            <!-- Undo / Redo -->
            {#if isUndoRedoEnabled}
              <div class="undo-redo-controls">
                <button
                  onclick={() => handleUndo()}
                  disabled={history.length <= 1}
                >
                  <img
                    src="/images/icons/undo-arrow.png"
                    alt="Undo"
                  />
                </button>

                <button
                  onclick={() => handleRedo()}
                  disabled={redoStack.length === 0}
                >
                  <img
                    src="/images/icons/redo-arrow.png"
                    alt="Redo"
                  />
                </button>
              </div>
            {/if}
          </div>
        {:else if isTextPen}
          <input
            type="text"
            id="scribble-beast-name"
            placeholder="Enter beast name..."
            maxlength={MAX_NAME_LENGTH}
            oninput={handleTextInput}
            class="name-input"
          />
        {/if}
      </div>
    {/if}
  </div>
</Round>

<style>
  .drawing-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
  }

  .canvas-wrapper {
    position: relative;
    width: min(520px, 90vw);
    height: min(var(--canvas-height), 90vw);
  }

  .drawing-canvas {
    position: absolute;
    top: 0;
    left: 0;
    border: 2px solid #333;
    border-radius: 8px;
    cursor: crosshair;
    touch-action: none;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    z-index: 10;
  }

  .overlay-canvas {
    position: absolute;
    top: 0;
    left: 0;
    border: 2px solid #333;
    border-radius: 8px;
    pointer-events: none;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    z-index: 20;
  }

  .background-canvas {
    position: absolute;
    top: 0;
    left: 0;
    border: 2px solid #333;
    border-radius: 8px;
    pointer-events: none;
    width: 100%;
    height: 100%;
    image-rendering: pixelated;
    z-index: 5;
  }

  .white-bg {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: white;
    border-radius: 8px;
    border: 2px solid #333;
  }

  .widget-container {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .drawing-controls-row {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-direction: row;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .color-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(36px, 1fr));
  gap: 0.75rem;
  max-width: 300px;
}

  .color-picker input[type='radio'] {
    display: none;
  }

  .color-picker label {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    cursor: pointer;
    border: 3px solid transparent;
    transition: border-color 0.2s;
  }

  .color-picker input[type='radio']:checked + label {
    border-color: #000;
  }

  .custom-color {
  margin-top: 0.5rem;
}

  .custom-color input[type='color'] {
    width: 50px;
    height: 40px;
    border: none;
    padding: 0;
    background: none;
  }

  .name-input {
    /* NOTE: Padding adjusted specifically for 'TheDogAteMyHomework' font baseline */
    padding: 0.5rem 1rem 0rem 1rem;
    font-size: var(--text-base);
    border: 2px solid #333;
    border-radius: 4px;
    width: 200px;
    line-height: 2.5;
    background-image: none; /* remove global underline gradient */
  }

  /* Styles for color pen slider */
  .pen-size-control {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }

  .pen-size-control input[type='range'] {
    width: 200px;
    appearance: none;
    -webkit-appearance: none;
    height: 24px;
    padding: 0;
    border: none;
    background: transparent;
    border-radius: 0;
  }

  .pen-size-control input[type='range']::-webkit-slider-runnable-track {
    height: 6px;
    border-radius: 999px;
    background: #cfd8dc;
  }

  .pen-size-control input[type='range']::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid #333;
    background: #ffffff;
    margin-top: -5px;
    cursor: pointer;
  }

  .pen-size-control input[type='range']::-moz-range-track {
    height: 6px;
    border-radius: 999px;
    background: #cfd8dc;
  }

  .pen-size-control input[type='range']::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid #333;
    background: #ffffff;
    cursor: pointer;
  }

  .pen-preview {
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pen-dot {
    border-radius: 50%;
    display: inline-block;
  }

  /* UNDO/REDO BUTTONS */
  .undo-redo-controls {
    display: flex;
    gap: 0.5rem;
    justify-content: center;
    margin-top: 0.5rem;
  }

  .undo-redo-controls button {
    width: 60px;
    height: 60px;
    padding: 0;
    border: 2px solid #333;
    background: white;
    border-radius: 10px;
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: bold;

    display: flex;
    align-items: center;
    justify-content: center;

    font-size: 1.4 rem;
    font-weight: 600;
  }

  .undo-redo-controls button img {
    width: 30px;
    height: 30px;
    object-fit: contain;
  }

  .undo-redo-controls button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>
