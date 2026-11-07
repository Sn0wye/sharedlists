//! Live presence in a list room: who is here, who is typing, which item each person is on.
//! Ephemeral: it lives in memory for as long as each socket does and never touches the database.
//!
//! Client → server, as JSON text frames on the list socket:
//! - `{"type":"hello","token":"<access token>"|null,"name":"Capivara anônima","color":"#5856d6"}`
//! - `{"type":"state","focus":"<item id>"|null,"typing":true}`
//!
//! Server → client: `presence_self { id }` to the socket itself right after it connects, then
//! `presence { count, peers }` to the whole room whenever someone joins, leaves or changes state.

use std::{
    collections::HashMap,
    future,
    sync::{Arc, Mutex},
    time::Duration,
};

use jsonwebtoken::{DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use uuid::Uuid;

use crate::{
    auth::Claims,
    realtime::{Event, Hub, Topic},
};

/// A typing flag lapses unless refreshed; clients refresh it every ~2s while typing.
const TYPING_TTL: Duration = Duration::from_secs(5);
/// Per-socket token bucket for incoming messages: bursts of 20, refilling 10/s.
const BURST: f64 = 20.0;
const RATE: f64 = 10.0;

#[derive(Clone, Default, PartialEq, Serialize)]
pub struct Peer {
    id: Uuid,
    /// The username when logged in, an anonymous animal name otherwise. `None` until `hello`.
    name: Option<String>,
    color: Option<String>,
    focus: Option<Uuid>,
    typing: bool,
}

/// Peers per room, in join order so avatars don't reshuffle.
#[derive(Default)]
pub struct Rooms(Mutex<HashMap<Topic, Vec<Peer>>>);

impl Rooms {
    /// Applies `change` and, if it reports a change, broadcasts the room's new snapshot.
    /// Publishing under the lock keeps snapshots in order.
    fn update(&self, hub: &Hub, topic: Topic, change: impl FnOnce(&mut Vec<Peer>) -> bool) {
        let mut rooms = self.0.lock().unwrap();
        let peers = rooms.entry(topic).or_default();
        if change(peers) {
            hub.publish(topic, &Event::Presence { count: peers.len(), peers });
        }
        if peers.is_empty() {
            rooms.remove(&topic);
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientMessage {
    Hello {
        token: Option<String>,
        name: Option<String>,
        color: Option<String>,
    },
    State {
        focus: Option<Uuid>,
        #[serde(default)]
        typing: bool,
    },
}

/// One socket's presence. Joining announces it; dropping it removes it from the room.
pub struct Session {
    hub: Arc<Hub>,
    topic: Topic,
    id: Uuid,
    typing_until: Option<Instant>,
    allowance: f64,
    last_message: Instant,
}

impl Session {
    /// Only list rooms have presence; group screens get `None`.
    pub fn join(hub: &Arc<Hub>, topic: Topic) -> Option<Self> {
        let Topic::List(_) = topic else { return None };
        let id = Uuid::new_v4();
        hub.presence.update(hub, topic, |peers| {
            peers.push(Peer { id, ..Default::default() });
            true
        });
        Some(Self {
            hub: hub.clone(),
            topic,
            id,
            typing_until: None,
            allowance: BURST,
            last_message: Instant::now(),
        })
    }

    /// Tells the client which peer in the snapshots is itself.
    pub fn welcome(&self) -> String {
        serde_json::json!({ "type": "presence_self", "id": self.id }).to_string()
    }

    pub fn typing_until(&self) -> Option<Instant> {
        self.typing_until
    }

    pub fn handle(&mut self, jwt: &DecodingKey, text: &str) {
        if !self.allow() {
            return;
        }
        let Ok(msg) = serde_json::from_str::<ClientMessage>(text) else {
            return;
        };
        match msg {
            ClientMessage::Hello { token, name, color } => {
                // A verified username wins; otherwise only an anonymous animal name is accepted,
                // which can't pass for a username (usernames have no spaces).
                let name = token
                    .and_then(|t| jsonwebtoken::decode::<Claims>(&t, jwt, &Validation::default()).ok())
                    .and_then(|data| data.claims.name)
                    .or_else(|| name.filter(|n| is_anonymous_name(n)));
                let color = color.filter(|c| is_hex_color(c));
                self.modify(|p| {
                    p.name = name;
                    p.color = color;
                });
            }
            ClientMessage::State { focus, typing } => {
                self.typing_until = typing.then(|| Instant::now() + TYPING_TTL);
                self.modify(|p| {
                    p.focus = focus;
                    p.typing = typing;
                });
            }
        }
    }

    /// Clears a typing flag the client stopped refreshing (e.g. the tab went to the background).
    pub fn expire_typing(&mut self) {
        self.typing_until = None;
        self.modify(|p| p.typing = false);
    }

    fn modify(&self, f: impl FnOnce(&mut Peer)) {
        self.hub.presence.update(&self.hub, self.topic, |peers| {
            let Some(peer) = peers.iter_mut().find(|p| p.id == self.id) else {
                return false;
            };
            let before = peer.clone();
            f(peer);
            *peer != before
        });
    }

    fn allow(&mut self) -> bool {
        let now = Instant::now();
        let refill = now.duration_since(self.last_message).as_secs_f64() * RATE;
        self.allowance = (self.allowance + refill).min(BURST);
        self.last_message = now;
        if self.allowance < 1.0 {
            return false;
        }
        self.allowance -= 1.0;
        true
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let id = self.id;
        self.hub.presence.update(&self.hub, self.topic, |peers| {
            peers.retain(|p| p.id != id);
            true
        });
    }
}

/// Resolves at `deadline`, or never when there is none. Meant for a `select!` branch.
pub async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => future::pending().await,
    }
}

fn is_anonymous_name(name: &str) -> bool {
    let animal = name
        .strip_suffix(" anônima")
        .or_else(|| name.strip_suffix(" anônimo"));
    animal.is_some_and(|a| {
        (2..=24).contains(&a.chars().count())
            && a.chars().all(|c| c.is_alphabetic() || matches!(c, ' ' | '-'))
    })
}

fn is_hex_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}
