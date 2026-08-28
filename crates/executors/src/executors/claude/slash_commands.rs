use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    str::FromStr,
    sync::OnceLock,
    time::Duration,
};

use convert_case::{Case, Casing};
use serde::Deserialize;
use tokio::{
    fs,
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};
use workspace_utils::command_ext::GroupSpawnNoWindowExt;

use super::{
    ClaudeCode, ClaudeEffort, ClaudeJson, ClaudePlugin, base_command,
    types::{Message, SDKControlRequest, SDKControlRequestType},
};
use crate::{
    command::{CommandBuildError, CommandBuilder, apply_overrides},
    env::{ExecutionEnv, RepoContext},
    executors::{ExecutorError, SlashCommandDescription},
    model_selector::{AgentInfo, ModelInfo, ReasoningOption},
};

const SLASH_COMMANDS_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) struct DiscoveredCommandsAndModels {
    slash_commands: Vec<String>,
    plugins: Vec<ClaudePlugin>,
    agents: Vec<String>,
    /// `None` when the CLI did not report a model catalog.
    models: Option<Vec<ClaudeDiscoveredModel>>,
}

/// Effort levels the `--effort` CLI flag accepts; also the fallback offered
/// when the CLI reports `supportsEffort` without an explicit level list.
pub(super) const CLAUDE_EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// One entry of the `models` array in the control-protocol initialize
/// response. Extra fields (resolvedModel, description, supportsFastMode, …)
/// are ignored.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClaudeDiscoveredModel {
    pub value: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub supports_effort: bool,
    #[serde(default)]
    pub supported_effort_levels: Vec<String>,
}

/// Extract the model catalog from a raw stdout line when it is the
/// control-protocol response to our initialize request.
pub(super) fn initialize_models_from_line(line: &str) -> Option<Vec<ClaudeDiscoveredModel>> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("type").and_then(|t| t.as_str()) != Some("control_response") {
        return None;
    }
    let models = value.pointer("/response/response/models")?.clone();
    serde_json::from_value(models).ok()
}

/// Map the CLI-reported model catalog onto the shared selector config.
/// Effort options only appear on models that advertise `supportsEffort`, and
/// are limited to levels the `--effort` flag understands.
pub(super) fn models_from_initialize(models: Vec<ClaudeDiscoveredModel>) -> Vec<ModelInfo> {
    let mut seen = HashSet::new();
    models
        .into_iter()
        .filter(|m| !m.value.trim().is_empty())
        .filter(|m| seen.insert(m.value.clone()))
        .map(|m| {
            let reasoning_options = if m.supports_effort {
                let mut levels: Vec<String> = m
                    .supported_effort_levels
                    .iter()
                    .filter(|level| ClaudeEffort::from_str(level).is_ok())
                    .cloned()
                    .collect();
                if levels.is_empty() {
                    levels = CLAUDE_EFFORT_LEVELS.map(String::from).to_vec();
                }
                ReasoningOption::from_names(levels)
            } else {
                vec![]
            };
            ModelInfo {
                name: m.display_name.unwrap_or_else(|| m.value.clone()),
                id: m.value,
                provider_id: None,
                reasoning_options,
                supports_fast: false,
            }
        })
        .collect()
}

impl ClaudeCode {
    fn extract_description(content: &str) -> Option<String> {
        if !content.starts_with("---") {
            return None;
        }

        // Find end of frontmatter
        let end = content[3..].find("---")?;
        let frontmatter = &content[3..3 + end];

        for line in frontmatter.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("description:") {
                return Some(rest.trim().to_string());
            }
        }
        None
    }

    fn make_key(prefix: &Option<String>, name: &str) -> String {
        prefix
            .as_ref()
            .map(|p| format!("{}:{}", p, name))
            .unwrap_or_else(|| name.to_string())
    }

    async fn try_read_description(path: &Path) -> Option<String> {
        match fs::read_to_string(path).await {
            Ok(content) => Self::extract_description(&content).or_else(|| {
                tracing::warn!("Failed to read frontmatter description from {:?}", path);
                None
            }),
            Err(e) => {
                tracing::error!("Failed to read file {:?}: {}", path, e);
                None
            }
        }
    }

    async fn scan_dir(
        dir: &Path,
        prefix: &Option<String>,
        get_entry: fn(&Path) -> Option<(&str, PathBuf)>,
    ) -> HashMap<String, String> {
        let mut result = HashMap::new();
        if let Ok(mut entries) = fs::read_dir(dir).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Some((name, desc_path)) = get_entry(&entry.path())
                    && let Some(desc) = Self::try_read_description(&desc_path).await
                {
                    result.insert(Self::make_key(prefix, name), desc);
                }
            }
        }
        result
    }

    async fn scan_base_path(base_path: &Path, prefix: Option<String>) -> HashMap<String, String> {
        let mut descriptions = HashMap::new();

        descriptions.extend(
            Self::scan_dir(&base_path.join("commands"), &prefix, |path| {
                path.extension()
                    .is_some_and(|ext| ext == "md")
                    .then(|| {
                        let name = path.file_stem()?.to_str()?;
                        Some((name, path.to_path_buf()))
                    })
                    .flatten()
            })
            .await,
        );

        descriptions.extend(
            Self::scan_dir(&base_path.join("skills"), &prefix, |path| {
                path.is_dir()
                    .then(|| {
                        let name = path.file_name()?.to_str()?;
                        let skill_md = path.join("SKILL.md");
                        skill_md.exists().then_some((name, skill_md))
                    })
                    .flatten()
            })
            .await,
        );

        descriptions
    }

    pub async fn discover_custom_command_descriptions(
        current_dir: &Path,
        plugins: &[ClaudePlugin],
    ) -> HashMap<String, String> {
        let mut descriptions = HashMap::new();

        // Project specific
        descriptions.extend(Self::scan_base_path(&current_dir.join(".claude"), None).await);

        // Global
        if let Some(home) = dirs::home_dir() {
            descriptions.extend(Self::scan_base_path(&home.join(".claude"), None).await);
        }

        // Plugins
        for plugin in plugins {
            descriptions
                .extend(Self::scan_base_path(&plugin.path, Some(plugin.name.clone())).await);
            descriptions.extend(
                Self::scan_base_path(&plugin.path.join(".claude"), Some(plugin.name.clone())).await,
            );
        }

        descriptions
    }

    pub(super) fn hardcoded_slash_commands() -> Vec<SlashCommandDescription> {
        static KNOWN_SLASH_COMMANDS: OnceLock<Vec<SlashCommandDescription>> = OnceLock::new();
        KNOWN_SLASH_COMMANDS.get_or_init(|| {
            vec![
                SlashCommandDescription {
                    name: "compact".to_string(),
                    description: Some(
                        "Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]"
                            .to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "review".to_string(),
                    description: Some("Review a pull request".to_string()),
                },
                SlashCommandDescription {
                    name: "security-review".to_string(),
                    description: Some(
                        "Complete a security review of the pending changes on the current branch"
                            .to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "init".to_string(),
                    description: Some(
                        "Initialize a new CLAUDE.md file with codebase documentation".to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "pr-comments".to_string(),
                    description: Some("Get comments from a GitHub pull request".to_string()),
                },
                SlashCommandDescription {
                    name: "context".to_string(),
                    description: Some(
                        "Visualize current context usage as a colored grid".to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "cost".to_string(),
                    description: Some(
                        "Show the total cost and duration of the current session".to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "fast".to_string(),
                    description: Some(
                        "Toggle Fast mode for higher-speed Opus responses. Use /fast [on|off]"
                            .to_string(),
                    ),
                },
                SlashCommandDescription {
                    name: "release-notes".to_string(),
                    description: Some("View release notes".to_string()),
                },
            ]
        }).clone()
    }

    async fn build_slash_commands_discovery_command_builder(
        &self,
    ) -> Result<CommandBuilder, CommandBuildError> {
        let mut builder =
            CommandBuilder::new(base_command(self.claude_code_router.unwrap_or(false)))
                .params(["-p"]);

        builder = builder.extend_params([
            "--verbose",
            "--output-format=stream-json",
            "--input-format=stream-json",
            "--max-turns",
            "1",
        ]);

        apply_overrides(builder, &self.cmd)
    }

    async fn discover_available_command_and_plugins(
        &self,
        current_dir: &Path,
    ) -> Result<DiscoveredCommandsAndModels, ExecutorError> {
        let command_builder = self
            .build_slash_commands_discovery_command_builder()
            .await?;
        let command_parts = command_builder.build_initial()?;
        let (program_path, args) = command_parts.into_resolved().await?;

        let mut command = Command::new(program_path);
        command
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .current_dir(current_dir)
            .args(&args);

        ExecutionEnv::new(RepoContext::default(), false, String::new())
            .with_profile(&self.cmd)
            .apply_to_command(&mut command);

        if self.disable_api_key.unwrap_or(false) {
            command.env_remove("ANTHROPIC_API_KEY");
        }

        let mut child = command.group_spawn_no_window()?;
        let stdout = child.inner().stdout.take().ok_or_else(|| {
            ExecutorError::Io(std::io::Error::other("Claude Code missing stdout"))
        })?;
        let mut stdin =
            child.inner().stdin.take().ok_or_else(|| {
                ExecutorError::Io(std::io::Error::other("Claude Code missing stdin"))
            })?;

        // The initialize control request makes the CLI report its model
        // catalog; the "/" user message triggers the init system message that
        // carries slash commands, plugins, and agents.
        let mut payload =
            serde_json::to_string(&SDKControlRequest::new(SDKControlRequestType::Initialize {
                hooks: None,
            }))?;
        payload.push('\n');
        payload.push_str(&serde_json::to_string(&Message::new_user("/".to_string()))?);
        payload.push('\n');

        let mut lines = BufReader::new(stdout).lines();

        let mut discovered: Option<(Vec<String>, Vec<ClaudePlugin>, Vec<String>)> = None;
        let mut models: Option<Vec<ClaudeDiscoveredModel>> = None;
        let discovery = async {
            stdin
                .write_all(payload.as_bytes())
                .await
                .map_err(ExecutorError::Io)?;
            stdin.flush().await.map_err(ExecutorError::Io)?;

            while let Some(line) = lines.next_line().await.map_err(ExecutorError::Io)? {
                if models.is_none()
                    && let Some(found) = initialize_models_from_line(&line)
                {
                    models = Some(found);
                }
                if let Ok(json) = serde_json::from_str::<ClaudeJson>(&line)
                    && let ClaudeJson::System {
                        subtype,
                        slash_commands,
                        plugins,
                        agents,
                        ..
                    } = &json
                    && matches!(subtype.as_deref(), Some("init"))
                {
                    discovered = Some((slash_commands.clone(), plugins.clone(), agents.clone()));
                    break;
                }
            }

            Ok::<(), ExecutorError>(())
        };

        let res = tokio::time::timeout(SLASH_COMMANDS_DISCOVERY_TIMEOUT, discovery).await;
        let _ = child.kill().await;

        let (slash_commands, plugins, agents) = match res {
            Ok(Ok(())) => discovered.unwrap_or_else(|| (vec![], vec![], vec![])),
            Ok(Err(e)) => return Err(e),
            Err(_) => {
                return Err(ExecutorError::Io(std::io::Error::other(
                    "Timed out discovering Claude Code slash commands",
                )));
            }
        };

        Ok(DiscoveredCommandsAndModels {
            slash_commands,
            plugins,
            agents,
            models,
        })
    }

    pub async fn discover_agents_and_slash_commands_initial(
        &self,
        current_dir: &Path,
    ) -> Result<
        (
            Vec<AgentInfo>,
            Vec<SlashCommandDescription>,
            Vec<ClaudePlugin>,
            Option<Vec<ModelInfo>>,
        ),
        ExecutorError,
    > {
        let DiscoveredCommandsAndModels {
            slash_commands: names,
            plugins,
            agents,
            models,
        } = self
            .discover_available_command_and_plugins(current_dir)
            .await?;

        let agent_options = Self::map_discovered_agents(agents);

        let builtin: HashSet<String> = Self::hardcoded_slash_commands()
            .iter()
            .map(|c| c.name.clone())
            .collect();

        let mut seen = HashSet::new();
        let slash_commands: Vec<SlashCommandDescription> = names
            .into_iter()
            .filter(|name| !name.is_empty() && !builtin.contains(name) && seen.insert(name.clone()))
            .map(|name| SlashCommandDescription {
                name,
                description: None,
            })
            .collect();

        // Empty catalog (or a CLI that predates the models field) keeps the
        // static fallback list.
        let live_models = models
            .map(models_from_initialize)
            .filter(|models| !models.is_empty());

        Ok((agent_options, slash_commands, plugins, live_models))
    }

    pub async fn fill_slash_command_descriptions(
        current_dir: &Path,
        plugins: &[ClaudePlugin],
        slash_commands: &[SlashCommandDescription],
    ) -> Vec<SlashCommandDescription> {
        let descriptions = Self::discover_custom_command_descriptions(current_dir, plugins).await;

        slash_commands
            .iter()
            .map(|cmd| SlashCommandDescription {
                name: cmd.name.clone(),
                description: descriptions
                    .get(&cmd.name)
                    .cloned()
                    .or(cmd.description.clone()),
            })
            .collect()
    }

    fn map_discovered_agents(agents: Vec<String>) -> Vec<AgentInfo> {
        let mut seen = HashSet::new();

        agents
            .into_iter()
            .filter(|name| name != "statusline-setup")
            .filter_map(|name| {
                let option = AgentInfo {
                    id: name.clone(),
                    label: Self::format_agent_label(&name),
                    description: None,
                    is_default: name == "general-purpose",
                };

                if option.id.trim().is_empty() || !seen.insert(option.id.clone()) {
                    return None;
                }
                Some(option)
            })
            .collect()
    }

    fn format_agent_label(raw: &str) -> String {
        let raw = raw.trim();

        if let Some((prefix, suffix)) = raw.split_once(':') {
            format!("{}: {}", prefix.trim(), suffix.to_case(Case::Title))
        } else {
            raw.to_case(Case::Title)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CLAUDE_EFFORT_LEVELS, ClaudeDiscoveredModel, initialize_models_from_line,
        models_from_initialize,
    };

    fn parse_models(json: serde_json::Value) -> Vec<ClaudeDiscoveredModel> {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn parses_models_from_initialize_control_response() {
        let line = r#"{"type":"control_response","response":{"subtype":"success","request_id":"r1","response":{"commands":[],"models":[{"value":"opus[1m]","resolvedModel":"claude-opus-4-8[1m]","displayName":"Opus","description":"Opus 4.8","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsFastMode":true},{"value":"haiku","displayName":"Haiku","description":"Haiku 4.5"}]}}}"#;

        let models = initialize_models_from_line(line).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].value, "opus[1m]");
        assert!(models[0].supports_effort);
        assert_eq!(models[0].supported_effort_levels.len(), 5);
        assert!(!models[1].supports_effort);

        // Non-control lines and responses without models are ignored.
        assert!(initialize_models_from_line(r#"{"type":"system","subtype":"init"}"#).is_none());
        assert!(
            initialize_models_from_line(
                r#"{"type":"control_response","response":{"subtype":"error","request_id":"r1","error":"nope"}}"#
            )
            .is_none()
        );
        assert!(initialize_models_from_line("not json").is_none());
    }

    #[test]
    fn initialize_models_map_to_model_infos() {
        let infos = models_from_initialize(parse_models(serde_json::json!([
            {
                "value": "opus[1m]",
                "displayName": "Opus",
                "supportsEffort": true,
                "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"]
            },
            {"value": "haiku", "displayName": "Haiku"},
            {"value": "haiku", "displayName": "Duplicate"},
            {"value": "  "}
        ])));

        assert_eq!(infos.len(), 2, "blank and duplicate values are dropped");
        let opus = &infos[0];
        assert_eq!(opus.id, "opus[1m]");
        assert_eq!(opus.name, "Opus");
        assert_eq!(
            opus.reasoning_options
                .iter()
                .map(|o| o.id.as_str())
                .collect::<Vec<_>>(),
            CLAUDE_EFFORT_LEVELS.to_vec()
        );
        assert!(!opus.supports_fast);

        let haiku = &infos[1];
        assert!(
            haiku.reasoning_options.is_empty(),
            "no effort options without supportsEffort"
        );
    }

    #[test]
    fn initialize_models_filter_unknown_levels_and_default_when_missing() {
        let infos = models_from_initialize(parse_models(serde_json::json!([
            {
                "value": "sonnet",
                "supportsEffort": true,
                "supportedEffortLevels": ["low", "banana"]
            },
            {"value": "fable", "supportsEffort": true}
        ])));

        assert_eq!(
            infos[0]
                .reasoning_options
                .iter()
                .map(|o| o.id.as_str())
                .collect::<Vec<_>>(),
            vec!["low"],
            "levels the --effort flag can't parse are dropped"
        );
        assert_eq!(infos[0].name, "sonnet", "value doubles as display name");
        assert_eq!(
            infos[1].reasoning_options.len(),
            CLAUDE_EFFORT_LEVELS.len(),
            "missing level list falls back to the full CLI set"
        );
    }
}
