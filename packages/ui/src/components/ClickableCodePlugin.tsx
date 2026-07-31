import { useEffect, useRef } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";

interface ClickableCodePluginProps {
  /** Function to find a matching diff target (supports partial/right-hand match) */
  findMatchingDiffTarget: (
    text: string,
  ) => { path: string; repoId: string | null } | null;
  /** Callback when a clickable code element is clicked */
  onCodeClick: (target: { path: string; repoId: string | null }) => void;
}

/**
 * Plugin that makes inline code elements clickable when their content
 * matches a file path in the current diffs.
 *
 * Supports fuzzy right-hand matching: "ChatMarkdown.tsx" will match
 * "src/components/ui-new/primitives/conversation/ChatMarkdown.tsx"
 *
 * Only active in read-only mode. Adds hover styling and click handlers
 * to matching code elements.
 */
export function ClickableCodePlugin({
  findMatchingDiffTarget,
  onCodeClick,
}: ClickableCodePluginProps) {
  const [editor] = useLexicalComposerContext();
  const processedElementsRef = useRef<WeakSet<Element>>(new WeakSet());

  useEffect(() => {
    const root = editor.getRootElement();
    if (!root) return;
    const clickHandlers = new Map<Element, EventListener>();

    // Process a single code element
    const processCodeElement = (element: Element) => {
      // Skip if already processed
      if (processedElementsRef.current.has(element)) return;

      const text = element.textContent?.trim() ?? "";

      // Check if this matches a diff path (supports fuzzy right-hand match)
      const matchedTarget = findMatchingDiffTarget(text);
      if (!matchedTarget) return;

      // Mark as processed
      processedElementsRef.current.add(element);

      // Add clickable styling
      (element as HTMLElement).style.cursor = "pointer";
      element.classList.add("clickable-code");

      // Add click handler - use the full matched path for navigation
      const handleClick = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        onCodeClick(matchedTarget);
      };

      element.addEventListener("click", handleClick);
      clickHandlers.set(element, handleClick);

      // Store cleanup function on the element
      (element as HTMLElement).dataset.clickableCode = "true";
    };

    // Process all existing code elements
    const processAllCodeElements = () => {
      // Inline code uses the theme class which includes 'font-mono' and 'bg-muted'
      // The actual class applied is from theme.text.code
      const codeElements = root.querySelectorAll(
        'code, .font-mono.bg-muted, [class*="text-code"]',
      );
      codeElements.forEach(processCodeElement);
    };

    // Initial processing
    processAllCodeElements();

    // Watch for new code elements being added
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        // Check added nodes
        for (const node of mutation.addedNodes) {
          if (node instanceof Element) {
            // Check if the node itself is a code element
            if (
              node.matches('code, .font-mono.bg-muted, [class*="text-code"]')
            ) {
              processCodeElement(node);
            }
            // Check child code elements
            const childCodeElements = node.querySelectorAll(
              'code, .font-mono.bg-muted, [class*="text-code"]',
            );
            childCodeElements.forEach(processCodeElement);
          }
        }
      }
    });

    observer.observe(root, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      // Clean up click handlers
      const clickableElements = root.querySelectorAll("[data-clickable-code]");
      clickableElements.forEach((el) => {
        const handler = clickHandlers.get(el);
        if (handler) el.removeEventListener("click", handler);
        (el as HTMLElement).style.cursor = "";
        el.classList.remove("clickable-code");
        delete (el as HTMLElement).dataset.clickableCode;
      });
      clickHandlers.clear();
      processedElementsRef.current = new WeakSet();
    };
  }, [editor, findMatchingDiffTarget, onCodeClick]);

  return null;
}
