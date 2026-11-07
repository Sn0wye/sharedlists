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
    lists::{self, Item, ListSummary},
    presence::{self, Peer},
};

/// Every socket watches one list; its room is keyed by the list id.
pub type Topic = Uuid;

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event<'a> {
    ListUpserted { list: &'a ListSummary },
    ListDeleted { id: Uuid },
    ItemUpserted { item: &'a Item },
    ItemDeleted { id: Uuid },
    Presence { count: usize, peers: &'a [Peer] },
    /// The client fell behind and missed events; it should refetch.
    Resync,
}

#[derive(Default)]
pub struct Hub {
    topics: Mutex<HashMap<Topic, broadcast::Sender<Arc<str>>>>,
    pub presence: presence::Rooms,
}

impl Hub {
    pub fn publish(&self, topic: Topic, event: &Event) {
        let topics = self.topics.lock().unwrap();
        if let Some(tx) = topics.get(&topic) {
            let _ = tx.send(serde_json::to_string(event).unwrap().into());
        }
    }

    fn subscribe(&self, topic: Topic) -> broadcast::Receiver<Arc<str>> {
        let mut topics = self.topics.lock().unwrap();
        topics
            .entry(topic)
            .or_insert_with(|| broadcast::channel(256).0)
            .subscribe()
    }

    /// Drops the topic once nobody listens.
    fn unsubscribe(&self, topic: Topic, rx: broadcast::Receiver<Arc<str>>) {
        drop(rx);
        let mut topics = self.topics.lock().unwrap();
        if topics.get(&topic).is_some_and(|tx| tx.receiver_count() == 0) {
            topics.remove(&topic);
        }
    }
}

#[derive(Deserialize)]
pub struct WsQuery {
    /// The list's link token.
    list: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(state): State<AppState>,
) -> AppResult<Response> {
    let topic = lists::resolve(&state, &q.list).await?;
    Ok(ws
        .max_message_size(4 * 1024)
        .on_upgrade(move |socket| serve(socket, topic, state)))
}

async fn serve(socket: WebSocket, topic: Topic, state: AppState) {
    let (mut tx, mut rx_socket) = socket.split();
    let mut rx = state.hub.subscribe(topic);
    let mut presence = presence::Session::join(&state.hub, topic);
    if tx.send(Message::Text(presence.welcome().into())).await.is_err() {
        return;
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
                if tx.send(Message::Text(text.as_ref().into())).await.is_err() {
                    break;
                }
            }
            incoming = rx_socket.next() => match incoming {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(Message::Text(text))) => presence.handle(&state.jwt.1, text.as_str()),
                // Anything else (e.g. a keep-alive) is ignored.
                Some(Ok(_)) => {}
            },
            _ = presence::sleep_until(presence.typing_until()) => presence.expire_typing(),
            _ = ping.tick() => {
                if tx.send(Message::Ping(Default::default())).await.is_err() {
                    break;
                }
            }
        }
    }

    drop(presence);
    state.hub.unsubscribe(topic, rx);
}
