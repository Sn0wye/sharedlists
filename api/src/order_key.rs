//! Fractional order keys: strings that sort with plain byte comparison, where a new key can
//! always be made between any two others, so moving an item rewrites only that item.
//!
//! Same format as the `fractional-indexing` npm package the web app uses for optimistic moves
//! (base 62, a variable-length integer part then a fraction), so either side can read the
//! other's keys. Postgres must compare them bytewise: the column is `COLLATE "C"`.

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO: u8 = DIGITS[0];

fn digit(c: u8) -> usize {
    DIGITS
        .iter()
        .position(|&d| d == c)
        .expect("valid order key digit")
}

/// Length of the integer part announced by its head: a..z are 2..27 chars, Z..A are 2..27 going down.
fn integer_len(head: u8) -> usize {
    match head {
        b'a'..=b'z' => (head - b'a') as usize + 2,
        b'A'..=b'Z' => (b'Z' - head) as usize + 2,
        _ => panic!("invalid order key head"),
    }
}

fn split(key: &str) -> (&str, &str) {
    key.split_at(integer_len(key.as_bytes()[0]).min(key.len()))
}

/// A fraction strictly between `a` and `b` (`b = None` means 1). Neither may end in a zero digit.
fn midpoint(a: &[u8], b: Option<&[u8]>) -> Vec<u8> {
    if let Some(b) = b {
        let n = (0..b.len())
            .take_while(|&i| a.get(i).copied().unwrap_or(ZERO) == b[i])
            .count();
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(midpoint(a.get(n..).unwrap_or_default(), Some(&b[n..])));
            return out;
        }
    }
    let da = a.first().map_or(0, |&c| digit(c));
    let db = b
        .and_then(|b| b.first())
        .map_or(DIGITS.len(), |&c| digit(c));
    if db - da > 1 {
        return vec![DIGITS[(da + db).div_ceil(2)]];
    }
    match b {
        Some(b) if b.len() > 1 => b[..1].to_vec(),
        _ => {
            let mut out = vec![DIGITS[da]];
            out.extend(midpoint(a.get(1..).unwrap_or_default(), None));
            out
        }
    }
}

fn increment(int: &str) -> Option<String> {
    let mut bytes = int.as_bytes().to_vec();
    let head = bytes.remove(0);
    for d in bytes.iter_mut().rev() {
        let next = digit(*d) + 1;
        if next < DIGITS.len() {
            *d = DIGITS[next];
            return Some(String::from_utf8([&[head], &bytes[..]].concat()).unwrap());
        }
        *d = ZERO;
    }
    // Every digit carried: the integer grows (or shrinks, below zero) by one digit.
    let head = match head {
        b'Z' => return Some("a0".into()),
        b'z' => return None,
        h => h + 1,
    };
    if head > b'a' {
        bytes.push(ZERO);
    } else {
        bytes.pop();
    }
    Some(String::from_utf8([&[head], &bytes[..]].concat()).unwrap())
}

fn decrement(int: &str) -> Option<String> {
    let last = *DIGITS.last().unwrap();
    let mut bytes = int.as_bytes().to_vec();
    let head = bytes.remove(0);
    for d in bytes.iter_mut().rev() {
        let i = digit(*d);
        if i > 0 {
            *d = DIGITS[i - 1];
            return Some(String::from_utf8([&[head], &bytes[..]].concat()).unwrap());
        }
        *d = last;
    }
    let head = match head {
        b'a' => return Some(format!("Z{}", last as char)),
        b'A' => return None,
        h => h - 1,
    };
    if head < b'Z' {
        bytes.push(last);
    } else {
        bytes.pop();
    }
    Some(String::from_utf8([&[head], &bytes[..]].concat()).unwrap())
}

/// A key that sorts strictly between `a` and `b` (either may be open-ended). Requires `a < b`.
pub fn between(a: Option<&str>, b: Option<&str>) -> String {
    match (a, b) {
        (None, None) => "a0".into(),
        (None, Some(b)) => {
            let (ib, fb) = split(b);
            // The smallest integer can't be decremented; go into its fraction instead.
            if ib.len() == 27 && ib.bytes().skip(1).all(|c| c == ZERO) && ib.starts_with('A') {
                return format!(
                    "{ib}{}",
                    String::from_utf8(midpoint(b"", Some(fb.as_bytes()))).unwrap()
                );
            }
            if ib.len() < b.len() {
                return ib.into();
            }
            decrement(ib).expect("order key below range")
        }
        (Some(a), None) => {
            let (ia, fa) = split(a);
            increment(ia).unwrap_or_else(|| {
                format!(
                    "{ia}{}",
                    String::from_utf8(midpoint(fa.as_bytes(), None)).unwrap()
                )
            })
        }
        (Some(a), Some(b)) => {
            debug_assert!(a < b, "order keys out of order: {a} >= {b}");
            let (ia, fa) = split(a);
            let (ib, fb) = split(b);
            if ia == ib {
                return format!(
                    "{ia}{}",
                    String::from_utf8(midpoint(fa.as_bytes(), Some(fb.as_bytes()))).unwrap()
                );
            }
            match increment(ia) {
                Some(i) if i.as_str() < b => i,
                _ => format!(
                    "{ia}{}",
                    String::from_utf8(midpoint(fa.as_bytes(), None)).unwrap()
                ),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::between;

    #[test]
    fn matches_reference_values() {
        // Expected values from the fractional-indexing package's own test suite.
        assert_eq!(between(None, None), "a0");
        assert_eq!(between(None, Some("a0")), "Zz");
        assert_eq!(between(Some("a0"), None), "a1");
        assert_eq!(between(Some("a0"), Some("a1")), "a0V");
        assert_eq!(between(Some("a1"), Some("a2")), "a1V");
        assert_eq!(between(Some("a0V"), Some("a1")), "a0l");
        assert_eq!(between(Some("Zz"), Some("a0")), "ZzV");
        assert_eq!(between(Some("Zz"), Some("a1")), "a0");
        assert_eq!(between(None, Some("Y00")), "Xzzz");
        assert_eq!(between(Some("bzz"), None), "c000");
        assert_eq!(between(Some("a0"), Some("a0V")), "a0G");
        assert_eq!(between(Some("a0"), Some("a0G")), "a08");
        assert_eq!(between(Some("b125"), Some("b129")), "b127");
        assert_eq!(between(Some("a0"), Some("a1V")), "a1");
        assert_eq!(between(Some("Zz"), Some("a01")), "a0");
        assert_eq!(between(None, Some("a0V")), "a0");
        assert_eq!(between(None, Some("b999")), "b99");
        assert_eq!(between(Some("az"), None), "b00");
        assert_eq!(between(Some("Zy"), None), "Zz");
        assert_eq!(between(Some("Zz"), None), "a0");
    }

    #[test]
    fn repeated_inserts_stay_ordered() {
        // Always inserting right after the first key is the worst case for key growth.
        let first = between(None, None);
        let mut next = between(Some(&first), None);
        for _ in 0..500 {
            let k = between(Some(&first), Some(&next));
            assert!(first < k && k < next);
            next = k;
        }
        let mut last = first.clone();
        for _ in 0..5000 {
            let k = between(Some(&last), None);
            assert!(k > last);
            last = k;
        }
        assert!(last.len() <= 4);
    }
}
