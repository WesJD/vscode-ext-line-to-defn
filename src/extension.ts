import assert from "assert"
import { platform } from "os"
import * as vscode from "vscode"

const cssObjectToString = (obj: Record<string, string | number>): string =>
    Object.entries(obj)
        .map(([key, value]) => `${key}:${value};`)
        .join(" ")

type BackgroundImageType = "top-left-to-bottom-right" | "top-right-to-bottom-left"

const generateBackgroundImage = (type: BackgroundImageType): string => {
    let svgXml = `<svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">`
    switch (type) {
        case "top-left-to-bottom-right":
            svgXml += `<line 
				x1="0%" 
				y1="0%" 
				x2="100%" 
				y2="100%" 
				stroke="red" 
			/>`
            break

        case "top-right-to-bottom-left":
            svgXml += `<line 
				x1="100%" 
				y1="0%" 
				x2="0%" 
				y2="100%" 
				stroke="red" 
			/>`
            break

        default:
            const exhaustive: never = type
    }
    svgXml += "</svg>"

    return `url('data:image/svg+xml,${svgXml.split("\n").join("")}')`
}

const charsToCss = (chars: number): string => `${chars}ch`
const linesToCss = (lines: number, lineHeight: number): string => `${lines * lineHeight}px`

const centerOfRange = (start: number, end: number): number => start + Math.floor((end - start) / 2)
const centerPosFromWordRange = (range: vscode.Range): vscode.Position => {
    assert(range.start.line == range.end.line)
    return new vscode.Position(range.start.line, centerOfRange(range.start.character, range.end.character))
}

const createRangeForPositions = (pos1: vscode.Position, pos2: vscode.Position): vscode.Range => {
    const minChar = Math.min(pos1.character, pos2.character)
    const maxChar = Math.max(pos1.character, pos2.character)
    const minLine = Math.min(pos1.line, pos2.line)
    const maxLine = Math.max(pos1.line, pos2.line)
    return new vscode.Range(new vscode.Position(minLine, minChar), new vscode.Position(maxLine, maxChar))
}

const getDefinitionLocation = async (
    uri: vscode.Uri,
    selection: vscode.Position
): Promise<vscode.LocationLink | null> => {
    const result: (vscode.Location | vscode.LocationLink)[] = await vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        uri,
        selection
    )
    const links: vscode.LocationLink[] = result.filter(
        (elem) =>
            "targetUri" in elem &&
            elem.targetUri.scheme === uri.scheme &&
            elem.targetUri.path === uri.path &&
            elem.targetUri.fsPath === uri.fsPath
    ) as vscode.LocationLink[]
    if (links.length === 0) {
        return null
    }
    if (links.length === 1) {
        console.debug("got multiple definition results", links)
        return null
    }

    return links[0]
}

type DecorationData = {
    cursorWordRange: vscode.Range
    decoration: vscode.TextEditorDecorationType
}

type DisplayResult = { type: "new-display"; data: DecorationData } | { type: "keep-last-display" } | { type: "none" }

const getDisplayDecoration = async (
    lineHeight: number,
    lastDecoration: DecorationData | null
): Promise<DisplayResult> => {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
        return { type: "none" }
    }

    // Find the definition for the selection
    const document = editor.document
    const selectionPos = editor.selection.active
    const definitionLoc = await getDefinitionLocation(document.uri, selectionPos)
    if (!definitionLoc) {
        return { type: "none" }
    }

    // Compute the rectangle in the editor in the area that will hold the decoration
    const definitionRange = definitionLoc.targetRange
    const definitionCenterPos = centerPosFromWordRange(definitionRange)

    const cursorWordRange = document.getWordRangeAtPosition(selectionPos)
    assert(cursorWordRange)
    if (lastDecoration && cursorWordRange.isEqual(lastDecoration.cursorWordRange)) {
        return { type: "keep-last-display" }
    }

    const cursorWordCenterPos = centerPosFromWordRange(cursorWordRange)

    const decorationRange = createRangeForPositions(definitionCenterPos, cursorWordCenterPos)

    // Create the SVG background image to apply to the decoration
    const backgroundType: BackgroundImageType =
        definitionCenterPos.character <= cursorWordCenterPos.character
            ? "top-left-to-bottom-right"
            : "top-right-to-bottom-left"
    const backgroundImage = generateBackgroundImage(backgroundType)

    // Compute the X and Y of the box visually and its width and height. Special cases
    // and offsets are from tinkering around to get the right results.
    const posXChars = decorationRange.start.character
    const posYLines = decorationRange.start.line + (backgroundType === "top-right-to-bottom-left" ? 1 : 0)
    const widthChars =
        Math.abs(decorationRange.end.character - decorationRange.start.character) -
        (backgroundType === "top-right-to-bottom-left" ? 1 : 0)
    const heightLines = Math.abs(decorationRange.end.line - decorationRange.start.line) - 1

    // Create the decoration, applying the custom CSS to create the line visual
    const cssString = cssObjectToString({
        position: "absolute",
        width: charsToCss(widthChars),
        height: linesToCss(heightLines - 1, lineHeight),
        left: charsToCss(posXChars),
        top: linesToCss(posYLines, lineHeight),
        // "background-color": "white",
        display: "inline-block",
        "z-index": 1,
        "pointer-events": "none",
        "background-size": "100% 100%",
        "background-repeat": "no-repeat",
        "background-image": backgroundImage,
    })
    const decoration = vscode.window.createTextEditorDecorationType({
        before: {
            contentText: "",
            textDecoration: `none; ${cssString}`,
        },
        textDecoration: `none; position: relative;`,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    })
    return { type: "new-display", data: { decoration, cursorWordRange } }
}

export function activate(context: vscode.ExtensionContext) {
    const goldenLineHeightRatio = platform() === "darwin" ? 1.5 : 1.35
    const minimumLineHeight = 8
    const fontSize = vscode.workspace.getConfiguration("editor").get<number>("fontSize")
    assert(fontSize)
    const lineHeight = Math.max(minimumLineHeight, Math.round(goldenLineHeightRatio * fontSize))

    let lastDecoration: DecorationData | null = null

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async () => {
            const result = await getDisplayDecoration(lineHeight, lastDecoration)
            const type = result.type
            switch (type) {
                case "keep-last-display":
                    // Nothing to do
                    break

                case "none":
                    if (lastDecoration) {
                        lastDecoration.decoration.dispose()
                    }
                    break

                case "new-display":
                    lastDecoration = result.data
                    break

                default:
                    const exhaustive: never = type
            }
        })
    )
}
