//! asciicast v2（Telepy 的終端機錄影）：解析成事件、照時間播放（`telepy recordings play`，像 `asciinema play`）。
//! 跟網頁播放器一樣，超過 `idle_limit` 秒的停頓縮短成 `idle_limit`。純函式在這裡，真的 sleep 在呼叫端。
//! asciicast v2 (Telepy's terminal recordings): parse into events and schedule them for playback, squeezing pauses
//! longer than `idle_limit` like the web player. The pure part lives here; the caller sleeps.

#[derive(Debug, Clone, PartialEq)]
pub struct Cast {
    pub width: u64,
    pub height: u64,
    /// (秒, 輸出)。只留 `o`（輸出）事件。/ (seconds, output); only `o` events.
    pub events: Vec<(f64, String)>,
}

pub fn parse(text: &str) -> Result<Cast, String> {
    let mut lines = text.lines().filter(|l| !l.trim().is_empty());
    let header: serde_json::Value = serde_json::from_str(lines.next().ok_or("empty recording")?).map_err(|e| format!("bad header: {e}"))?;
    if header.get("version").and_then(|v| v.as_u64()) != Some(2) {
        return Err("not an asciicast v2 recording".into());
    }
    let mut events = Vec::new();
    for l in lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(l) else { continue };
        let (Some(t), Some(kind), Some(data)) = (v.get(0).and_then(|x| x.as_f64()), v.get(1).and_then(|x| x.as_str()), v.get(2).and_then(|x| x.as_str())) else { continue };
        if kind == "o" {
            events.push((t, data.to_string()));
        }
    }
    Ok(Cast { width: header["width"].as_u64().unwrap_or(80), height: header["height"].as_u64().unwrap_or(24), events })
}

/// 每個事件前要等多久（秒）：除以速度、停頓上限 `idle_limit`（0 = 不限）。/ The delay before each event.
pub fn schedule(events: &[(f64, String)], speed: f64, idle_limit: f64) -> Vec<f64> {
    let speed = if speed > 0.0 { speed } else { 1.0 };
    let mut prev = 0.0;
    events
        .iter()
        .map(|(t, _)| {
            let mut gap = (t - prev).max(0.0);
            prev = *t;
            if idle_limit > 0.0 {
                gap = gap.min(idle_limit);
            }
            gap / speed
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_squeezes_pauses() {
        let text = "{\"version\":2,\"width\":100,\"height\":30}\n[0.5,\"o\",\"$ \"]\n[0.6,\"r\",\"120x40\"]\n[10.5,\"o\",\"ls\\r\\n\"]\nnot json\n[11.0,\"o\",\"a b\\r\\n\"]\n";
        let c = parse(text).unwrap();
        assert_eq!((c.width, c.height), (100, 30));
        assert_eq!(c.events.len(), 3);
        assert_eq!(c.events[1].1, "ls\r\n");
        assert_eq!(schedule(&c.events, 1.0, 2.0), vec![0.5, 2.0, 0.5]);
        assert_eq!(schedule(&c.events, 2.0, 0.0), vec![0.25, 5.0, 0.25]);
        assert!(parse("{\"version\":1}").is_err());
    }
}
