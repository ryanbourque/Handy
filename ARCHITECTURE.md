# Handy Architecture Reference

**Version:** 0.7.0  
**Last Updated:** January 2026

This document provides a comprehensive architectural overview of Handy for developers building custom frontends, integrating HTTP endpoints, or extending the core functionality. It serves as the definitive technical reference for understanding the system's internal workings.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Technology Stack](#technology-stack)
3. [Architecture Patterns](#architecture-patterns)
4. [Core Components](#core-components)
5. [Audio Recording Pipeline](#audio-recording-pipeline)
6. [Transcription Pipeline](#transcription-pipeline)
7. [Push-to-Talk Implementation](#push-to-talk-implementation)
8. [State Management](#state-management)
9. [Event System](#event-system)
10. [Integration Points](#integration-points)
11. [Custom Frontend Integration](#custom-frontend-integration)
12. [HTTP Endpoint Integration](#http-endpoint-integration)
13. [Audio File Handling](#audio-file-handling)
14. [Extension Points](#extension-points)

---

## System Overview

Handy is a cross-platform desktop application built with Tauri, combining:
- **Backend:** Rust for system integration, audio processing, and ML inference
- **Frontend:** React + TypeScript for settings UI
- **Communication:** Tauri's IPC (command/event) system with type-safe bindings

### High-Level Flow

```
User Triggers Shortcut
    ↓
Shortcut Handler (Rust)
    ↓
AudioRecordingManager starts recording
    ↓
Audio captured + VAD filtering
    ↓
TranscriptionManager processes audio
    ↓
Whisper/Parakeet model inference
    ↓
Post-processing (optional LLM)
    ↓
Text output → Clipboard/Paste + History
```

---

## Technology Stack

### Backend (Rust)

| Component | Library | Purpose |
|-----------|---------|---------|
| **Framework** | `tauri 2.9.1` | Desktop app framework, IPC bridge |
| **Audio I/O** | `cpal 0.16.0` | Cross-platform audio recording |
| **Resampling** | `rubato 0.16.2` | Audio sample rate conversion |
| **VAD** | `vad-rs` (Silero) | Voice Activity Detection |
| **Transcription** | `transcribe-rs 0.2.2` | Whisper/Parakeet/Moonshine engines |
| **Keyboard** | `rdev`, `handy-keys 0.1.4` | Global shortcuts, keyboard simulation |
| **Input Simulation** | `enigo 0.6.1` | Keyboard/mouse events |
| **HTTP** | `reqwest 0.12` | LLM post-processing API calls |
| **Database** | `rusqlite 0.37` | History storage (SQLite) |
| **Settings** | `tauri-plugin-store 2.4.1` | Persistent key-value storage |

### Frontend (React/TypeScript)

| Component | Library | Purpose |
|-----------|---------|---------|
| **Framework** | `react 18.3.1` | UI components |
| **Bundler** | `vite 6.4.1` | Build tool, dev server |
| **Styling** | `tailwindcss 4.1.16` | Utility-first CSS |
| **State** | `zustand 5.0.8` | Client-side state management |
| **i18n** | `react-i18next 16.4.1` | Internationalization |
| **Type Safety** | `tauri-specta 2.0.0-rc.21` | Auto-generated TypeScript bindings |

---

## Architecture Patterns

### 1. Manager Pattern

Core functionality is organized into **Managers** — stateful, long-lived objects initialized at startup:

- **AudioRecordingManager** (`src-tauri/src/managers/audio.rs`)
- **TranscriptionManager** (`src-tauri/src/managers/transcription.rs`)
- **ModelManager** (`src-tauri/src/managers/model.rs`)
- **HistoryManager** (`src-tauri/src/managers/history.rs`)

Managers are:
- Wrapped in `Arc<Manager>` for thread-safe shared ownership
- Stored in Tauri's managed state (`app.manage()`)
- Accessed from commands via `app.state::<Arc<Manager>>()`

### 2. Command-Event Architecture

**Commands** (Frontend → Backend):
```typescript
import { invoke } from '@tauri-apps/api/core';
const result = await invoke('get_available_models');
```

**Events** (Backend → Frontend):
```rust
app.emit("transcription_complete", payload)?;
```

```typescript
import { listen } from '@tauri-apps/api/event';
await listen('transcription_complete', (event) => {
  console.log(event.payload);
});
```

### 3. State Flow

```
User Action (Frontend)
    ↓
Tauri Command (IPC)
    ↓
Rust Manager (Backend)
    ↓
Settings/State Update (tauri-plugin-store)
    ↓
Event Emission (IPC)
    ↓
Frontend State Update (Zustand)
```

---

## Core Components

### Entry Point: `lib.rs`

**Location:** `src-tauri/src/lib.rs`

**Key Functions:**
- `run()` - Main application entry point
- `initialize_core_logic()` - Initializes all managers, shortcuts, tray, signal handlers
- `show_main_window()` - Brings settings window to front

**Initialization Sequence:**
1. Setup logging with file rotation
2. Create managers (Audio, Model, Transcription, History)
3. Add managers to Tauri managed state
4. Initialize shortcuts
5. Setup signal handlers (Unix: SIGUSR2)
6. Create tray icon
7. Create recording overlay window

### Managers

#### AudioRecordingManager

**Location:** `src-tauri/src/managers/audio.rs`

**Responsibilities:**
- Manages microphone lifecycle (always-on vs on-demand mode)
- Coordinates with `AudioRecorder` for low-level audio capture
- Applies Voice Activity Detection (VAD) filtering
- Handles mute-while-recording feature
- Emits audio level events for UI visualization

**Key Methods:**
```rust
pub fn new(app: &AppHandle) -> Result<Self>
pub fn try_start_recording(&self, binding_id: &str) -> bool
pub fn stop_recording(&self, binding_id: &str) -> Option<Vec<f32>>
pub fn is_recording(&self) -> bool
pub fn apply_mute(&self)
pub fn remove_mute(&self)
pub fn start_microphone_stream(&self) -> Result<()>
pub fn stop_microphone_stream(&self)
```

**State Machine:**
```
Idle → Recording → Processing → Idle
```

**Microphone Modes:**
- **Always-On:** Microphone stream stays open, reduces latency
- **On-Demand:** Stream opens on recording start, closes on stop

#### TranscriptionManager

**Location:** `src-tauri/src/managers/transcription.rs`

**Responsibilities:**
- Loads and manages ML models (Whisper/Parakeet/Moonshine)
- Performs speech-to-text inference
- Handles model auto-unloading based on timeout settings
- Emits model loading/unloading events

**Key Methods:**
```rust
pub fn new(app_handle: &AppHandle, model_manager: Arc<ModelManager>) -> Result<Self>
pub fn transcribe(&self, samples: Vec<f32>) -> Result<String>
pub fn initiate_model_load(&self)
pub fn unload_model(&self) -> Result<()>
pub fn is_model_loaded(&self) -> bool
pub fn is_loading(&self) -> bool
```

**Model Lifecycle:**
- Models are loaded lazily on first transcription
- Idle timeout thread monitors last activity
- Auto-unload based on `model_unload_timeout` setting
- Loading is async with blocking for concurrent transcriptions

---

## Audio Recording Pipeline

### Flow Diagram

```
Microphone Hardware
    ↓
cpal::Stream (platform-specific audio API)
    ↓
AudioRecorder::build_stream()
    ↓
Sample Format Conversion (to f32)
    ↓
FrameResampler (convert to 16kHz mono)
    ↓
VAD Processing (Silero)
    ↓
AudioVisualiser (spectrum analysis for UI)
    ↓
Sample Buffer (Vec<f32>)
```

### AudioRecorder Details

**Location:** `src-tauri/src/audio_toolkit/audio/recorder.rs`

**Architecture:**
- Worker thread runs audio stream
- Command channel (`Cmd`) for start/stop control
- Sample channel for captured audio data
- VAD filter processes frames in real-time

**VAD (Voice Activity Detection):**
- **SileroVad:** ONNX model-based VAD (`silero_vad_v4.onnx`)
- **SmoothedVad:** Wrapper with hysteresis to reduce false positives

**Configuration:**
```rust
SileroVad::new(vad_path, 0.3) // threshold = 0.3
SmoothedVad::new(Box::new(silero), 15, 15, 2)
// min_speech_frames=15, min_silence_frames=15, margin_frames=2
```

---

## Transcription Pipeline

### Flow Diagram

```
Audio Samples (Vec<f32>, 16kHz mono)
    ↓
TranscriptionManager::transcribe()
    ↓
Load Model (if not already loaded)
    ↓
Engine-Specific Inference
    ├─ WhisperEngine
    ├─ ParakeetEngine
    └─ MoonshineEngine
    ↓
Raw Transcription Text
    ↓
Text Filtering (custom_words, corrections)
    ↓
Chinese Variant Conversion (optional)
    ↓
LLM Post-Processing (optional)
    ↓
Final Text
    ↓
Save to History
    ↓
Paste/Clipboard Output
```

### Post-Processing

**Location:** `src-tauri/src/actions.rs`

**Step 1: Chinese Variant Conversion**
- If `selected_language` is `zh-Hans` or `zh-Hant`
- Uses `ferrous-opencc` library for conversion

**Step 2: LLM Post-Processing**
```rust
async fn maybe_post_process_transcription(
    settings: &AppSettings,
    transcription: &str,
) -> Option<String>
```

**Supported Providers:**
- OpenAI-compatible APIs (OpenAI, Anthropic, OpenRouter, etc.)
- Apple Intelligence (macOS only)

**HTTP Request (OpenAI-compatible):**
```rust
POST {base_url}/chat/completions
Content-Type: application/json
Authorization: Bearer {api_key}

{
  "model": "{model}",
  "messages": [{
    "role": "user",
    "content": "{prompt}"
  }]
}
```

---

## Push-to-Talk Implementation

### Shortcut Handling Architecture

**Location:** `src-tauri/src/shortcut/`

**Two Implementations:**
1. **Tauri Plugin** (`tauri_impl.rs`)
2. **Handy Keys** (`handy_keys.rs`) - macOS default

**Shared Logic:** `handler.rs`

**Modes:**

1. **Push-to-Talk Mode** (`settings.push_to_talk == true`):
```
Key Press   → action.start()
Key Release → action.stop()
```

2. **Toggle Mode** (`settings.push_to_talk == false`):
```
Key Press → Toggle state (start/stop)
Key Release → Ignored
```

### TranscribeAction Flow

**Start:**
```rust
1. Initiate model load (async)
2. Update tray icon → Recording
3. Start audio recording
4. Play feedback sound + apply mute
5. Register cancel shortcut
```

**Stop:**
```rust
1. Unregister cancel shortcut
2. Remove mute
3. Play stop feedback
4. Update tray icon → Transcribing
5. Spawn async task:
   - Stop recording, get samples
   - Transcribe audio
   - Post-process (Chinese, LLM)
   - Save to history
   - Paste text
   - Update tray icon → Idle
```

---

## State Management

### Settings Storage

**Location:** `src-tauri/src/settings.rs`

**Storage:** `tauri-plugin-store` (JSON file)
- **Path:** `{app_data_dir}/settings.json`

**Key Settings:**
```rust
pub struct AppSettings {
    pub bindings: HashMap<String, ShortcutBinding>,
    pub push_to_talk: bool,
    pub audio_feedback: bool,
    pub selected_model: String,
    pub always_on_microphone: bool,
    pub post_process_enabled: bool,
    pub post_process_provider_id: String,
    pub post_process_api_keys: HashMap<String, String>,
    pub paste_method: PasteMethod,
    pub clipboard_handling: ClipboardHandling,
    // ... more settings
}
```

---

## Event System

### Backend → Frontend Events

| Event Name | Payload | Purpose |
|------------|---------|---------|
| `audio-levels` | `Vec<f32>` | Audio spectrum for UI visualization |
| `model-state-changed` | `ModelStateEvent` | Model loading/unloading/error |
| `download-progress` | `DownloadProgress` | Model download progress |
| `transcription-complete` | `String` | Transcription text |
| `recording-started` | `null` | Recording has started |
| `recording-stopped` | `null` | Recording has stopped |

**Emit (Rust):**
```rust
app.emit("audio-levels", levels)?;
```

**Listen (TypeScript):**
```typescript
import { listen } from '@tauri-apps/api/event';

await listen<number[]>('audio-levels', (event) => {
  console.log('Levels:', event.payload);
});
```

---

## Custom Frontend Integration

### Remove Default Frontend

Modify `src-tauri/tauri.conf.json`:
```json
{
  "app": {
    "windows": []
  }
}
```

### Create Custom Window

```rust
let window = WebviewWindowBuilder::new(
    app,
    "custom",
    WebviewUrl::App("index.html".into())
)
.title("Custom Frontend")
.build()?;
```

### Use Existing Commands

```typescript
import { invoke } from '@tauri-apps/api/core';

// Get history
const history = await invoke('get_history_entries', {
  limit: 50,
  offset: 0
});
```

### Listen to Events

```typescript
import { listen } from '@tauri-apps/api/event';

await listen('transcription-complete', (event) => {
  const text = event.payload as string;
  // Send to your HTTP endpoint
});
```

---

## HTTP Endpoint Integration

### Option 1: Modify Backend

**Location:** `src-tauri/src/actions.rs`, in `TranscribeAction::stop()`

```rust
// After getting final_text

let http_client = reqwest::Client::new();
let endpoint_url = "https://your-api.com/transcriptions";

tauri::async_runtime::spawn(async move {
    let payload = serde_json::json!({
        "text": final_text,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });
    
    match http_client
        .post(endpoint_url)
        .json(&payload)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            log::info!("Sent to endpoint successfully");
        }
        Err(e) => log::error!("Failed to send: {}", e),
    }
});
```

### Option 2: Frontend Event Handler

```typescript
await listen('transcription-complete', async (event) => {
  const text = event.payload as string;
  
  await fetch('https://your-api.com/transcriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, timestamp: new Date().toISOString() })
  });
});
```

### Option 3: Add Settings

**In `settings.rs`:**
```rust
pub http_endpoint_enabled: bool,
pub http_endpoint_url: String,
pub http_endpoint_api_key: Option<String>,
```

**Create helper `src-tauri/src/http_integration.rs`:**
```rust
pub async fn send_transcription_to_endpoint(
    endpoint_url: &str,
    api_key: Option<&str>,
    transcription: &str,
) -> Result<(), String> {
    let client = reqwest::Client::new();
    
    let mut request = client.post(endpoint_url)
        .json(&serde_json::json!({ "text": transcription }));
    
    if let Some(key) = api_key {
        request = request.header("Authorization", format!("Bearer {}", key));
    }
    
    request.send().await
        .map_err(|e| e.to_string())?;
    
    Ok(())
}
```

---

## Audio File Handling

### Recording Audio Files

**Location:** `src-tauri/src/managers/history.rs`

```rust
pub async fn save_transcription(
    &self,
    samples: Vec<f32>,
    transcription: String,
    post_processed_text: Option<String>,
    post_process_prompt: Option<String>,
) -> Result<()> {
    // Generate filename
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let file_name = format!("handy_recording_{}.wav", timestamp);
    let file_path = self.recordings_dir.join(&file_name);
    
    // Save WAV file
    save_wav_file(&samples, &file_path, 16000)?;
    
    // Save to database
    // ...
}
```

### Uploading Audio Files

**Add upload after saving:**

```rust
// After saving WAV file locally
let file_bytes = std::fs::read(&file_path)?;

if settings.audio_upload_enabled {
    tauri::async_runtime::spawn(async move {
        match upload_audio_file(
            &settings.audio_upload_url,
            &settings.audio_upload_api_key,
            &file_name,
            file_bytes
        ).await {
            Ok(remote_url) => {
                log::info!("Uploaded: {}", remote_url);
            }
            Err(e) => log::error!("Upload failed: {}", e),
        }
    });
}
```

**Upload helper:**

```rust
async fn upload_audio_file(
    upload_url: &str,
    api_key: &str,
    file_name: &str,
    file_bytes: Vec<u8>,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    
    let form = reqwest::multipart::Form::new()
        .text("filename", file_name.to_string())
        .part(
            "file",
            reqwest::multipart::Part::bytes(file_bytes)
                .file_name(file_name.to_string())
                .mime_str("audio/wav").unwrap()
        );
    
    let response = client
        .post(upload_url)
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    
    let json: serde_json::Value = response.json().await
        .map_err(|e| e.to_string())?;
    
    Ok(json["url"].as_str().unwrap().to_string())
}
```

### Audio Format

**Current:** WAV (uncompressed PCM)
- Sample rate: 16,000 Hz
- Channels: 1 (mono)
- Bit depth: 32-bit float

**Storage Locations:**
- **Database:** `{app_data_dir}/history.db`
- **Audio Files:** `{app_data_dir}/recordings/`

---

## Extension Points

### 1. Custom Shortcut Actions

**Add to `ACTION_MAP` in `actions.rs`:**

```rust
struct CustomAction;

impl ShortcutAction for CustomAction {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        // Your logic here
    }
    
    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        // Cleanup
    }
}

pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert("transcribe".to_string(), Arc::new(TranscribeAction));
    map.insert("custom".to_string(), Arc::new(CustomAction)); // Add here
    map
});
```

### 2. Custom Post-Processing

```rust
pub async fn custom_post_process(
    transcription: &str,
) -> Option<String> {
    let processed = transcription
        .replace("um", "")
        .trim()
        .to_string();
    
    Some(processed)
}
```

### 3. Alternative Output Methods

```rust
pub fn paste_custom(text: String, app_handle: AppHandle) -> Result<(), String> {
    // Send to websocket, MQTT, etc.
    send_to_websocket("ws://localhost:8080", &text)?;
    Ok(())
}
```

---

## Key Directories

```
src-tauri/src/
├── lib.rs                  # Entry point
├── actions.rs              # Shortcut actions
├── settings.rs             # Settings structures
├── clipboard.rs            # Paste operations
├── llm_client.rs          # LLM API client
├── managers/
│   ├── audio.rs           # Audio recording
│   ├── transcription.rs   # Transcription
│   ├── model.rs           # Model management
│   └── history.rs         # History storage
├── audio_toolkit/
│   ├── audio/             # Low-level recording
│   └── vad/               # Voice detection
├── commands/              # Tauri commands
└── shortcut/              # Keyboard shortcuts
```

---

## Development Workflow

### Building Extensions

1. Fork repository
2. Add custom logic
3. Rebuild bindings: `cargo build`
4. Test: `bun run tauri dev`
5. Build: `bun run tauri build`

### Debugging

**Rust:**
```rust
log::debug!("Value: {:?}", value);
```

**Logs:**
- macOS: `~/Library/Logs/com.pais.handy/`
- Windows: `%APPDATA%\com.pais.handy\logs\`
- Linux: `~/.local/share/com.pais.handy/logs/`

---

## Performance

- **Model cold start:** 2-10 seconds
- **Warm transcription:** < 1 second
- **Always-On latency:** ~100-200ms
- **On-Demand latency:** +500-1000ms

---

## Platform Notes

- **macOS:** Metal acceleration, `handy-keys` default
- **Windows:** Vulkan acceleration, Tauri shortcuts default
- **Linux:** OpenBLAS + Vulkan, Wayland needs `wtype`/`dotool`

---

## Additional Resources

- **README:** [README.md](README.md)
- **Build Guide:** [BUILD.md](BUILD.md)
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Repository:** https://github.com/cjpais/Handy
- **Discord:** https://discord.com/invite/WVBeWsNXK4

---

**Maintained by the Handy community. Contributions welcome!**
