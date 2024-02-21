import assert from "assert"
import { platform } from "os"
import * as vscode from "vscode"

const cssObjectToString = (obj: Record<string, string | number>): string =>
    Object.entries(obj)
        .map(([key, value]) => `${key}:${value};`)
        .join(" ")

type BackgroundImageType = "top-left-to-bottom-right" | "top-right-to-bottom-left" | "vertical"

const generateBackgroundImage = (type: BackgroundImageType, config: Config): string => {
    let svgXml = `<svg width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">`
    switch (type) {
        case "top-left-to-bottom-right":
            svgXml += `<line 
				x1="0%" 
				y1="0%" 
				x2="100%" 
				y2="100%" 
				stroke="${config.lineColor}" 
                stroke-width="${config.lineWidth}"
                stroke-opacity="${config.lineOpacity}%"
			/>`
            break

        case "top-right-to-bottom-left":
            svgXml += `<line 
				x1="100%" 
				y1="0%" 
				x2="0%" 
				y2="100%" 
				stroke="${config.lineColor}" 
                stroke-width="${config.lineWidth}"
                stroke-opacity="${config.lineOpacity}%"
			/>`
            break

        case "vertical":
            svgXml += `<line 
				x1="50%" 
				y1="0%" 
				x2="50%" 
				y2="100%" 
				stroke="${config.lineColor}" 
                stroke-width="${config.lineWidth}"
                stroke-opacity="${config.lineOpacity}%"
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

const getDefinitionRange = async (uri: vscode.Uri, selection: vscode.Position): Promise<vscode.Range | null> => {
    const locations: (vscode.Location | vscode.LocationLink)[] = await vscode.commands.executeCommand(
        "vscode.executeDefinitionProvider",
        uri,
        selection
    )
    if (locations.length === 0) {
        return null
    }
    if (locations.length !== 1) {
        console.debug("got multiple definition locations", locations)
        return null
    }

    // We need to verify the URI is the same file. Otherwise, we'll draw a line
    // to a definition location that doesn't exist in the current viewed file.
    const location = locations[0]
    const isLocationLink = "targetUri" in location
    const locationUri: vscode.Uri = isLocationLink ? location.targetUri : location.uri
    if (locationUri.path !== uri.path) {
        return null
    }

    // `targetSelectionRange` seems to be a more precise range if it is present
    if (isLocationLink && location.targetSelectionRange) {
        return location.targetSelectionRange
    }
    if (isLocationLink) {
        return location.targetRange
    }
    return location.range
}

type DecorationData = {
    cursorWordRange: vscode.Range
    decoration: vscode.TextEditorDecorationType
}

type DisplayResult = { type: "new-display"; data: DecorationData } | { type: "keep-last-display" } | { type: "none" }

const getDisplayDecoration = async (
    config: Config,
    lineHeight: number,
    lastDecoration: DecorationData | null
): Promise<DisplayResult> => {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
        return { type: "none" }
    }

    const document = editor.document

    // Get the word range position to not search for the definition again
    // if we don't need to
    const selectionPos = editor.selection.active
    const cursorWordRange = document.getWordRangeAtPosition(selectionPos)
    if (!cursorWordRange) {
        return { type: "none" }
    }
    if (lastDecoration && cursorWordRange.isEqual(lastDecoration.cursorWordRange)) {
        return { type: "keep-last-display" }
    }

    // Find the definition for the selection
    const definitionRange = await getDefinitionRange(document.uri, selectionPos)
    if (!definitionRange) {
        return { type: "none" }
    }

    // Compute the rectangle in the editor in the area that will hold the decoration
    const definitionCenterPos = centerPosFromWordRange(definitionRange)
    const cursorWordCenterPos = centerPosFromWordRange(cursorWordRange)
    const decorationRange = createRangeForPositions(definitionCenterPos, cursorWordCenterPos)

    // Create the SVG background image to apply to the decoration
    const widthDiff = definitionCenterPos.character - cursorWordCenterPos.character
    let backgroundType: BackgroundImageType
    if (widthDiff === 0) {
        backgroundType = "vertical"
    } else if (widthDiff < 0) {
        backgroundType = "top-left-to-bottom-right"
    } else {
        backgroundType = "top-right-to-bottom-left"
    }

    const backgroundImage = generateBackgroundImage(backgroundType, config)

    // Compute the width and height of the visual box. Special case is from
    // tinkering with it.
    const widthChars = Math.max(
        2,
        decorationRange.end.character -
            decorationRange.start.character -
            (backgroundType === "top-right-to-bottom-left" ? 1 : 0)
    )
    const heightLines = decorationRange.end.line - decorationRange.start.line

    // Create the CSS for the decoration to have the background SVG line
    const cssString = cssObjectToString({
        position: "absolute",
        width: charsToCss(widthChars),
        height: linesToCss(heightLines - 1, lineHeight),
        top: linesToCss(1, lineHeight),
        display: "inline-block",
        "z-index": 1,
        "pointer-events": "none",
        "background-size": "100% 100%",
        "background-repeat": "no-repeat",
        "background-image": backgroundImage,
    })

    // Create and add the decoration to the editor
    const decoration = vscode.window.createTextEditorDecorationType({
        before: {
            contentText: "",
            textDecoration: `none; ${cssString}`,
        },
        textDecoration: `none; position: relative;`,
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    })
    editor.setDecorations(decoration, [decorationRange])

    return { type: "new-display", data: { decoration, cursorWordRange } }
}

const calcLineHeight = (): number => {
    const goldenLineHeightRatio = platform() === "darwin" ? 1.5 : 1.35
    const minimumLineHeight = 8
    const fontSize = vscode.workspace.getConfiguration("editor").get<number>("fontSize")
    assert(fontSize, "could not load font size")
    return Math.max(minimumLineHeight, Math.round(goldenLineHeightRatio * fontSize))
}

type Config = {
    readonly lineColor: string
    readonly lineWidth: number
    /**
     * Percentage opacity of the line
     */
    readonly lineOpacity: number
}

const getConfig = (): Config => {
    const config = vscode.workspace.getConfiguration("lineToDefinition")
    return {
        lineColor: config.get<string>("lineColor") ?? "red",
        lineWidth: config.get<number>("lineWidth") ?? 1,
        lineOpacity: config.get<number>("opacity") ?? 50,
    }
}

export function activate(context: vscode.ExtensionContext) {
    const lineHeight = calcLineHeight()
    let config: Config = getConfig()
    let lastDecoration: DecorationData | null = null

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(() => {
            config = getConfig()
        })
    )

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(async () => {
            const result = await getDisplayDecoration(config, lineHeight, lastDecoration)
            const type = result.type
            switch (type) {
                case "keep-last-display":
                    // Nothing to do
                    break

                case "none":
                    if (lastDecoration) {
                        lastDecoration.decoration.dispose()
                        lastDecoration = null
                    }
                    break

                case "new-display":
                    if (lastDecoration) {
                        lastDecoration.decoration.dispose()
                    }
                    lastDecoration = result.data
                    break

                default:
                    const exhaustive: never = type
            }
        })
    )
}
