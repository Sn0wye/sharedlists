//! In-memory pub/sub over WebSockets. Clients only receive events here; all writes go through REST.
//! Single-instance by design: scale out would need Postgres LISTEN/NOTIFY or Redis behind `Hub::publish`.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    extract::{
        Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{
    AppState,
    error::AppResult,
    groups,
    lists::{self, Item, ListSummary},
};

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum Topic {
    /// A group's screen: summaries of its lists.
    Group(Uuid),
    List(Uuid),
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event<'a> {
    ListUpserted { list: &'a ListSummary },
    ListDeleted { id: Uuid },
    ItemUpserted { item: &'a Item },
    ItemDeleted { id: Uuid },
    Presence { count: usize },
    GroupRenamed { id: Uuid, name: &'a str },
    /// The client fell behind and missed events; it should refetch.
    Resync,
}

/// Sent when a group's link is rotated; the server then closes the socket. Kept as a literal
/// so `serve` can recognise it without parsing.
const REVOKED: &str = r#"{"type":"revoked"}"#;

#[derive(Default)]
pub struct Hub {
    topics: Mutex<HashMap<Topic, broadcast::Sender<Arc<str>>>>,
}

impl Hub {
    pub fn publish(&self, topic: Topic, event: &Event) {
        self.send(topic, serde_json::to_string(event).unwrap().into());
    }

    fn send(&self, topic: Topic, text: Arc<str>) {
        let topics = self.topics.lock().unwrap();
        if let Some(tx) = topics.get(&topic) {
            let _ = tx.send(text);
        }
    }

    /// Publishes a list summary to its group and to the list's own room.
    pub fn list_changed(&self, list: &ListSummary) {
        let event = Event::ListUpserted { list };
        self.publish(Topic::Group(list.group_id), &event);
        self.publish(Topic::List(list.id), &event);
    }

    /// Disconnects everyone watching the group or any of its lists.
    pub fn revoke(&self, group_id: Uuid, list_ids: &[Uuid]) {
        let text: Arc<str> = REVOKED.into();
        self.send(Topic::Group(group_id), text.clone());
        for &id in list_ids {
            self.send(Topic::List(id), text.clone());
        }
    }

    fn subscribe(&self, topic: Topic) -> (broadcast::Receiver<Arc<str>>, usize) {
        let mut topics = self.topics.lock().unwrap();
        let tx = topics
            .entry(topic)
            .or_insert_with(|| broadcast::channel(256).0);
        let rx = tx.subscribe();
        (rx, tx.receiver_count())
    }

    /// Returns the remaining subscriber count, dropping the topic once nobody listens.
    fn unsubscribe(&self, topic: Topic, rx: broadcast::Receiver<Arc<str>>) -> usize {
        drop(rx);
        let mut topics = self.topics.lock().unwrap();
        let count = topics.get(&topic).map_or(0, |tx| tx.receiver_count());
        if count == 0 {
            topics.remove(&topic);
        }
        count
    }
}

#[derive(Deserialize)]
pub struct WsQuery {
    /// The group's edit or read-only token. Browsers can't set headers on a WebSocket.
    group: String,
    list: Option<Uuid>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(state): State<AppState>,
) -> AppResult<Response> {
    let access = groups::resolve(&state, &q.group).await?;
    let topic = match q.list {
        Some(id) => {
            lists::ensure_in_group(&state, id, access.group_id).await?;
            Topic::List(id)
        }
        None => Topic::Group(access.group_id),
    };
    Ok(ws
        .max_message_size(4 * 1024)
        .on_upgrade(move |socket| serve(socket, topic, state)))
}

async fn serve(socket: WebSocket, topic: Topic, state: AppState) {
    let (mut tx, mut rx_socket) = socket.split();
    let (mut rx, count) = state.hub.subscribe(topic);
    if let Topic::List(_) = topic {
        state.hub.publish(topic, &Event::Presence { count });
    }

    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            msg = rx.recv() => {
                let text = match msg {
                    Ok(text) => text,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        serde_json::to_string(&Event::Resync).unwrap().into()
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if tx.send(Message::Text(text.as_ref().into())).await.is_err() || &*text == REVOKED {
                    break;
                }
            }
            incoming = rx_socket.next() => match incoming {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                // Clients may send anything (e.g. a keep-alive); we ignore it.
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => {
                if tx.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
        }
    }

    let remaining = state.hub.unsubscribe(topic, rx);
    if let (Topic::List(_), 1..) = (topic, remaining) {
        state.hub.publish(topic, &Event::Presence { count: remaining });
    }
}
