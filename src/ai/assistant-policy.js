'use strict';

const { isResolvedModelBinding, HOST_AUTHORIZED_TOOLS } = require('./model-profiles');

const validToolName = (name) => typeof name === 'string' && name.length <= 128
  && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(name);

function policyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function trustedAssistant(binding) {
  if (!isResolvedModelBinding(binding)) return null;
  const assistant = binding.assistant;
  return assistant && assistant.identityType === 'ai' && assistant.id === binding.assistantId
    && assistant.archived !== true ? assistant : null;
}

// This selector covers only tools which the host has already authorized for the
// current run. It is not a tool provider, project grant, or permission/Gate bypass.
function selectsHostDirectory(assistant) {
  return assistant.id === 'assistant_codex' && assistant.builtIn === true
    && assistant.toolPolicy.allowedTools.includes(HOST_AUTHORIZED_TOOLS);
}

function allowedByRole(name, assistant) {
  return validToolName(name) && assistant && assistant.toolPolicy.mode === 'allowlist'
    && (selectsHostDirectory(assistant) || assistant.toolPolicy.allowedTools.includes(name));
}

function toolName(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return null;
  const canonical = tool.name;
  const legacy = tool.function && typeof tool.function === 'object' ? tool.function.name : undefined;
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) return null;
  const name = canonical === undefined ? legacy : canonical;
  return validToolName(name) ? name : null;
}

/** Preserve each host tool's schema and identity while applying the role policy. */
function filterAssistantTools(tools, binding) {
  const assistant = trustedAssistant(binding);
  if (!assistant || !Array.isArray(tools)) return [];
  return tools.filter((tool) => allowedByRole(toolName(tool), assistant));
}

/** Dispatch must also enforce host registry/schema/project/permission policies. */
function assertAssistantToolAllowed(name, binding) {
  if (!allowedByRole(name, trustedAssistant(binding))) {
    throw policyError('ASSISTANT_TOOL_DENIED', 'This assistant is not allowed to use the requested tool');
  }
  return true;
}

/**
 * The project argument is resolved by main, not a renderer-supplied path. An
 * association is only a restriction; knowledge also requires a current opaque
 * project-binding token. Automatic memory injection and explicit memory tools
 * are deliberately independent policies.
 */
function assistantContextPolicy(binding, project) {
  const assistant = trustedAssistant(binding);
  if (!assistant) return { projectContext: false, projectMemory: false, toolsAllowed: false };
  const projectId = project && typeof project.id === 'string' && project.id.trim()
    && project.id.length <= 128 ? project.id : null;
  if (assistant.projectId !== null && projectId !== null && assistant.projectId !== projectId) {
    throw policyError('ASSISTANT_PROJECT_MISMATCH', 'This assistant is associated with a different project');
  }
  const projectBound = typeof binding.projectBindingId === 'string'
    && binding.projectBindingId.length > 0 && projectId !== null
    && (assistant.projectId === null || assistant.projectId === projectId);
  return {
    projectContext: Boolean(projectBound && assistant.knowledge.projectContext),
    projectMemory: Boolean(projectBound && assistant.knowledge.projectMemory),
    toolsAllowed: assistant.toolPolicy.mode === 'allowlist' && assistant.toolPolicy.allowedTools.length > 0,
  };
}

module.exports = { filterAssistantTools, assertAssistantToolAllowed, assistantContextPolicy };
