//! CherryTree `.ctb` extraction.
//!
//! A `.ctb` file is a plain SQLite database, not an archive. Its schema is
//! defined in `src/ct/ct_storage_sqlite.cc` of giuspen/cherrytree:
//!
//! * `node(node_id, name, txt, syntax, tags, is_ro, is_richtxt, has_codebox,
//!   has_table, has_image, level, ts_creation, ts_lastsave)`
//! * `children(node_id, father_id, sequence, master_id)` — `father_id = 0`
//!   marks a top-level node, and `sequence` is the sibling order the user sees
//! * `codebox(node_id, offset, justification, txt, syntax, …)`
//! * `grid(node_id, offset, justification, txt, col_min, col_max)` — tables
//! * `image(node_id, offset, …, png, filename, link, time)`
//!
//! How a node's `txt` reads depends on `syntax`: for the rich-text syntax
//! (`custom-colors`) it is an XML document whose `<rich_text>` elements carry
//! the prose; for anything else (`plain-text`, or a language id like `python3`)
//! it is the literal text. Getting that backwards yields either XML tags in the
//! output or an empty document, so the two are handled separately.
//!
//! The result is Markdown: the note tree becomes nested headings, so the
//! hierarchy the user built is preserved as document structure rather than
//! flattened into one wall of text.
//!
//! Only `.ctb` is handled here. CherryTree's other containers are different
//! formats — `.ctd` is XML, `.ctz` is a compressed `.ctd`, and `.ctx` is an
//! encrypted `.ctb` that cannot be read without the user's password.

use std::path::Path;

use rusqlite::{Connection, OpenFlags};

/// CherryTree's syntax id for a rich-text node, from `CtConst::RICH_TEXT_ID`.
const RICH_TEXT_SYNTAX: &str = "custom-colors";
/// Syntax id for a node the user marked as plain text.
const PLAIN_TEXT_SYNTAX: &str = "plain-text";
/// Deepest heading level Markdown defines. Nodes below it keep the depth in
/// their text rather than emitting `#######`, which no renderer understands.
const MAX_HEADING_DEPTH: usize = 6;

struct CtNode {
    id: i64,
    name: String,
    txt: String,
    syntax: String,
}

/// Extract a `.ctb` note tree as Markdown.
pub fn extract_ctb_text(path: &str) -> Result<String, String> {
    let file = Path::new(path);
    if !file.exists() {
        return Err(format!("File does not exist: '{path}'"));
    }

    // Read-only so ingesting a note file can never modify the user's notes,
    // and so a database CherryTree has open is not disturbed.
    let conn = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| {
        format!("Failed to open '{path}' as a CherryTree SQLite database: {e}")
    })?;

    let nodes = load_nodes(&conn)?;
    if nodes.is_empty() {
        return Err(format!(
            "'{path}' has no CherryTree nodes — it may be a different SQLite database, or a .ctx file (encrypted)"
        ));
    }

    let mut out = String::new();
    for (node, depth) in walk_tree(&conn, &nodes)? {
        render_node(&conn, node, depth, &mut out)?;
    }

    let text = out.trim_end().to_string();
    if text.is_empty() {
        return Err(format!("'{path}' contains no readable text"));
    }
    Ok(text)
}

fn load_nodes(conn: &Connection) -> Result<Vec<CtNode>, String> {
    let mut stmt = conn
        .prepare("SELECT node_id, name, txt, syntax FROM node")
        .map_err(|e| format!("CherryTree database has no readable `node` table: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(CtNode {
                id: row.get(0)?,
                name: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                txt: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                syntax: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })
        })
        .map_err(|e| format!("Failed to read CherryTree nodes: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to read CherryTree nodes: {e}"))
}

/// Walk the note tree depth-first in the order the user sees it, returning each
/// node with its depth.
///
/// A `children` row can point at a parent that no longer exists, and a corrupt
/// file can even describe a cycle. Neither may hang or drop content, so the
/// walk tracks what it has already emitted and appends anything the traversal
/// never reached.
fn walk_tree<'a>(
    conn: &Connection,
    nodes: &'a [CtNode],
) -> Result<Vec<(&'a CtNode, usize)>, String> {
    let mut stmt = conn
        .prepare("SELECT node_id, father_id FROM children ORDER BY sequence ASC, node_id ASC")
        .map_err(|e| format!("CherryTree database has no readable `children` table: {e}"))?;
    let edges = stmt
        .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
        .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
        .map_err(|e| format!("Failed to read the CherryTree node tree: {e}"))?;

    let mut ordered = Vec::with_capacity(nodes.len());
    let mut emitted = std::collections::HashSet::new();

    // father_id = 0 is CherryTree's marker for a top-level node.
    let roots: Vec<i64> = edges
        .iter()
        .filter(|(_, father)| *father == 0)
        .map(|(id, _)| *id)
        .collect();

    let mut stack: Vec<(i64, usize)> = roots.iter().rev().map(|id| (*id, 0)).collect();
    while let Some((id, depth)) = stack.pop() {
        if !emitted.insert(id) {
            continue;
        }
        if let Some(node) = nodes.iter().find(|n| n.id == id) {
            ordered.push((node, depth));
        }
        let children: Vec<i64> = edges
            .iter()
            .filter(|(_, father)| *father == id)
            .map(|(child, _)| *child)
            .collect();
        for child in children.into_iter().rev() {
            stack.push((child, depth + 1));
        }
    }

    // Anything the tree never reached still holds the user's text.
    for node in nodes {
        if emitted.insert(node.id) {
            ordered.push((node, 0));
        }
    }

    Ok(ordered)
}

fn render_node(
    conn: &Connection,
    node: &CtNode,
    depth: usize,
    out: &mut String,
) -> Result<(), String> {
    let title = node.name.trim();
    if !title.is_empty() {
        let level = (depth + 1).min(MAX_HEADING_DEPTH);
        out.push_str(&"#".repeat(level));
        out.push(' ');
        out.push_str(title);
        out.push_str("\n\n");
    }

    let body = if node.syntax == RICH_TEXT_SYNTAX {
        rich_text_to_plain(&node.txt)
    } else {
        node.txt.clone()
    };
    let body = body.trim_end();
    if !body.is_empty() {
        // A node whose syntax names a language is a code node; fence it so the
        // language survives into the wiki instead of reading as broken prose.
        if node.syntax != RICH_TEXT_SYNTAX && node.syntax != PLAIN_TEXT_SYNTAX && !node.syntax.is_empty() {
            out.push_str("```");
            out.push_str(&node.syntax);
            out.push('\n');
            out.push_str(body);
            out.push_str("\n```\n\n");
        } else {
            out.push_str(body);
            out.push_str("\n\n");
        }
    }

    for (code, syntax) in load_codeboxes(conn, node.id)? {
        out.push_str("```");
        if syntax != PLAIN_TEXT_SYNTAX {
            out.push_str(&syntax);
        }
        out.push('\n');
        out.push_str(code.trim_end());
        out.push_str("\n```\n\n");
    }

    for table_xml in load_tables(conn, node.id)? {
        if let Some(table) = table_to_markdown(&table_xml) {
            out.push_str(&table);
            out.push_str("\n\n");
        }
    }

    Ok(())
}

fn load_codeboxes(conn: &Connection, node_id: i64) -> Result<Vec<(String, String)>, String> {
    // A file written by an older CherryTree may lack these tables; a missing
    // codebox is not a reason to fail the whole document.
    let mut stmt = match conn.prepare("SELECT txt, syntax FROM codebox WHERE node_id=? ORDER BY offset ASC") {
        Ok(stmt) => stmt,
        Err(_) => return Ok(Vec::new()),
    };
    let rows = stmt
        .query_map([node_id], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            ))
        })
        .map_err(|e| format!("Failed to read CherryTree code boxes: {e}"))?;
    Ok(rows.filter_map(Result::ok).filter(|(txt, _)| !txt.trim().is_empty()).collect())
}

fn load_tables(conn: &Connection, node_id: i64) -> Result<Vec<String>, String> {
    let mut stmt = match conn.prepare("SELECT txt FROM grid WHERE node_id=? ORDER BY offset ASC") {
        Ok(stmt) => stmt,
        Err(_) => return Ok(Vec::new()),
    };
    let rows = stmt
        .query_map([node_id], |row| Ok(row.get::<_, Option<String>>(0)?.unwrap_or_default()))
        .map_err(|e| format!("Failed to read CherryTree tables: {e}"))?;
    Ok(rows.filter_map(Result::ok).filter(|txt| !txt.trim().is_empty()).collect())
}

/// Pull the prose out of a rich-text node's XML payload.
///
/// Only the text matters here — CherryTree's formatting attributes (colour,
/// weight, links) have no place in the plain text handed to an LLM.
fn rich_text_to_plain(xml: &str) -> String {
    let doc = match roxmltree::Document::parse(xml) {
        Ok(doc) => doc,
        // Not XML after all. Better to hand over the raw payload than to drop
        // the node's content entirely.
        Err(_) => return xml.to_string(),
    };
    let mut out = String::new();
    for node in doc.descendants().filter(|n| n.has_tag_name("rich_text")) {
        if let Some(text) = node.text() {
            out.push_str(text);
        }
    }
    out
}

/// Convert a `grid` payload into a Markdown table.
///
/// The XML is `<table><row><cell>…</cell></row>…</table>`, and CherryTree
/// writes **the header row last** (`CtXmlHelper::table_to_xml`: "put header at
/// the end"). Rendering the rows in file order would therefore label the table
/// with its final data row, so the last row is moved back to the front.
fn table_to_markdown(xml: &str) -> Option<String> {
    let doc = roxmltree::Document::parse(xml).ok()?;
    let mut rows: Vec<Vec<String>> = Vec::new();
    for row in doc.descendants().filter(|n| n.has_tag_name("row")) {
        let cells: Vec<String> = row
            .children()
            .filter(|n| n.has_tag_name("cell"))
            .map(|cell| cell.text().unwrap_or_default().replace('|', "\\|").replace('\n', " "))
            .collect();
        if !cells.is_empty() {
            rows.push(cells);
        }
    }
    if rows.is_empty() {
        return None;
    }
    let header = rows.pop()?;
    rows.insert(0, header);

    let width = rows.iter().map(Vec::len).max()?;
    let mut out = String::new();
    for (index, row) in rows.iter().enumerate() {
        out.push('|');
        for column in 0..width {
            out.push(' ');
            out.push_str(row.get(column).map(String::as_str).unwrap_or(""));
            out.push_str(" |");
        }
        out.push('\n');
        if index == 0 {
            out.push('|');
            for _ in 0..width {
                out.push_str(" --- |");
            }
            out.push('\n');
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDb(std::path::PathBuf);

    impl Drop for TempDb {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// Build a `.ctb` with CherryTree's real schema.
    fn make_ctb(name: &str) -> (TempDb, String) {
        let path = std::env::temp_dir().join(format!(
            "llm-wiki-ctb-{name}-{}-{:?}.ctb",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_file(&path);
        let conn = Connection::open(&path).expect("create db");
        conn.execute_batch(
            "CREATE TABLE node (node_id INTEGER UNIQUE, name TEXT, txt TEXT, syntax TEXT, tags TEXT,
                 is_ro INTEGER, is_richtxt INTEGER, has_codebox INTEGER, has_table INTEGER,
                 has_image INTEGER, level INTEGER, ts_creation INTEGER, ts_lastsave INTEGER);
             CREATE TABLE children (node_id INTEGER UNIQUE, father_id INTEGER, sequence INTEGER, master_id INTEGER);
             CREATE TABLE codebox (node_id INTEGER, offset INTEGER, justification TEXT, txt TEXT,
                 syntax TEXT, width INTEGER, height INTEGER, is_width_pix INTEGER,
                 do_highl_bra INTEGER, do_show_linenum INTEGER);
             CREATE TABLE grid (node_id INTEGER, offset INTEGER, justification TEXT, txt TEXT,
                 col_min INTEGER, col_max INTEGER);",
        )
        .expect("schema");
        let path_string = path.to_string_lossy().to_string();
        (TempDb(path), path_string)
    }

    fn add_node(path: &str, id: i64, name: &str, txt: &str, syntax: &str, father: i64, seq: i64) {
        let conn = Connection::open(path).expect("open");
        conn.execute(
            "INSERT INTO node (node_id, name, txt, syntax) VALUES (?, ?, ?, ?)",
            rusqlite::params![id, name, txt, syntax],
        )
        .expect("insert node");
        conn.execute(
            "INSERT INTO children (node_id, father_id, sequence) VALUES (?, ?, ?)",
            rusqlite::params![id, father, seq],
        )
        .expect("insert child");
    }

    #[test]
    fn rich_text_nodes_become_headings_and_prose() {
        let (_guard, path) = make_ctb("rich");
        add_node(
            &path,
            1,
            "Parent",
            r#"<?xml version="1.0" encoding="UTF-8"?><node><rich_text>Top level note.</rich_text></node>"#,
            "custom-colors",
            0,
            1,
        );
        add_node(
            &path,
            2,
            "Child",
            r#"<node><rich_text weight="heavy">Nested </rich_text><rich_text>note.</rich_text></node>"#,
            "custom-colors",
            1,
            1,
        );

        let out = extract_ctb_text(&path).expect("extract");
        assert!(out.contains("# Parent"), "{out}");
        assert!(out.contains("## Child"), "{out}");
        assert!(out.contains("Top level note."), "{out}");
        // Adjacent rich_text runs are one sentence, not two fragments.
        assert!(out.contains("Nested note."), "{out}");
        // Formatting attributes must not leak into the text.
        assert!(!out.contains("weight"), "{out}");
        assert!(!out.contains("<rich_text"), "{out}");
    }

    #[test]
    fn a_child_is_rendered_under_its_own_parent_in_sequence_order() {
        let (_guard, path) = make_ctb("order");
        add_node(&path, 1, "First", "<node><rich_text>a</rich_text></node>", "custom-colors", 0, 1);
        add_node(&path, 2, "Second", "<node><rich_text>b</rich_text></node>", "custom-colors", 0, 2);
        add_node(&path, 3, "FirstChild", "<node><rich_text>c</rich_text></node>", "custom-colors", 1, 1);

        let out = extract_ctb_text(&path).expect("extract");
        let first = out.find("# First").expect("first");
        let child = out.find("## FirstChild").expect("child");
        let second = out.find("# Second").expect("second");
        assert!(first < child && child < second, "tree order wrong:\n{out}");
    }

    #[test]
    fn plain_and_code_nodes_keep_their_text_verbatim() {
        let (_guard, path) = make_ctb("plain");
        add_node(&path, 1, "Notes", "line one\nline two", "plain-text", 0, 1);
        add_node(&path, 2, "Script", "print('hi')", "python3", 0, 2);

        let out = extract_ctb_text(&path).expect("extract");
        assert!(out.contains("line one\nline two"), "{out}");
        // A plain-text node must not be fenced as if it were code.
        assert!(!out.contains("```plain-text"), "{out}");
        // A language node must be, so the language is not lost.
        assert!(out.contains("```python3\nprint('hi')\n```"), "{out}");
    }

    #[test]
    fn codeboxes_and_tables_attached_to_a_node_are_included() {
        let (_guard, path) = make_ctb("widgets");
        add_node(&path, 1, "Doc", "<node><rich_text>Body.</rich_text></node>", "custom-colors", 0, 1);
        let conn = Connection::open(&path).expect("open");
        conn.execute(
            "INSERT INTO codebox (node_id, offset, txt, syntax) VALUES (1, 0, ?, 'rust')",
            rusqlite::params!["fn main() {}"],
        )
        .expect("codebox");
        // CherryTree writes the header row LAST; the data rows come first.
        conn.execute(
            "INSERT INTO grid (node_id, offset, txt) VALUES (1, 1, ?)",
            rusqlite::params![
                "<table><row><cell>alpha</cell><cell>1</cell></row><row><cell>Name</cell><cell>Value</cell></row></table>"
            ],
        )
        .expect("grid");
        drop(conn);

        let out = extract_ctb_text(&path).expect("extract");
        assert!(out.contains("```rust\nfn main() {}\n```"), "{out}");
        let header = out.find("| Name | Value |").expect("header row missing");
        let data = out.find("| alpha | 1 |").expect("data row missing");
        assert!(header < data, "header must be restored to the top:\n{out}");
        assert!(out.contains("| --- | --- |"), "{out}");
    }

    #[test]
    fn heading_depth_stops_at_six() {
        let (_guard, path) = make_ctb("deep");
        add_node(&path, 1, "L1", "<node><rich_text>x</rich_text></node>", "custom-colors", 0, 1);
        for id in 2..=9 {
            add_node(
                &path,
                id,
                &format!("L{id}"),
                "<node><rich_text>x</rich_text></node>",
                "custom-colors",
                id - 1,
                1,
            );
        }
        let out = extract_ctb_text(&path).expect("extract");
        assert!(out.contains("###### L6"), "{out}");
        assert!(out.contains("###### L9"), "deep nodes clamp to h6:\n{out}");
        assert!(!out.contains("####### "), "no h7 exists in Markdown:\n{out}");
    }

    #[test]
    fn an_orphaned_node_is_still_emitted() {
        let (_guard, path) = make_ctb("orphan");
        add_node(&path, 1, "Reachable", "<node><rich_text>a</rich_text></node>", "custom-colors", 0, 1);
        // A children row pointing at a parent that does not exist.
        add_node(&path, 2, "Orphan", "<node><rich_text>b</rich_text></node>", "custom-colors", 404, 1);

        let out = extract_ctb_text(&path).expect("extract");
        assert!(out.contains("Reachable"), "{out}");
        assert!(out.contains("Orphan"), "content must not be dropped:\n{out}");
    }

    #[test]
    fn a_cycle_in_the_tree_terminates() {
        let (_guard, path) = make_ctb("cycle");
        add_node(&path, 1, "A", "<node><rich_text>a</rich_text></node>", "custom-colors", 0, 1);
        add_node(&path, 2, "B", "<node><rich_text>b</rich_text></node>", "custom-colors", 1, 1);
        let conn = Connection::open(&path).expect("open");
        conn.execute("UPDATE children SET father_id=2 WHERE node_id=1", [])
            .expect("cycle");
        drop(conn);

        // Nothing is reachable from father_id=0 now, so both nodes arrive via
        // the unreached-node sweep — the point is that this returns at all.
        let out = extract_ctb_text(&path).expect("extract");
        assert!(out.contains("A") && out.contains("B"), "{out}");
    }

    #[test]
    fn a_non_cherrytree_sqlite_file_is_rejected_clearly() {
        let path = std::env::temp_dir().join(format!("llm-wiki-ctb-bogus-{}.ctb", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let guard = TempDb(path.clone());
        let conn = Connection::open(&path).expect("create");
        conn.execute("CREATE TABLE unrelated (id INTEGER)", []).expect("table");
        drop(conn);

        let err = extract_ctb_text(&path.to_string_lossy()).unwrap_err();
        assert!(err.contains("node"), "error should name what was missing: {err}");
        drop(guard);
    }

    #[test]
    fn a_missing_file_reports_the_path() {
        let err = extract_ctb_text("/nonexistent/notes.ctb").unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    #[test]
    fn malformed_rich_text_xml_falls_back_to_the_raw_payload() {
        assert_eq!(rich_text_to_plain("not <xml at all"), "not <xml at all");
    }
}
