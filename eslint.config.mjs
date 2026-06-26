import js from "@eslint/js"
import tseslint from "typescript-eslint"
import globals from "globals"

export default tseslint.config([
	{
		ignores: ["dist/**", "node_modules/**", "dev/**", "docs/**", "coverage/**"]
	},
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		languageOptions: {
			globals: {
				...globals.node
			}
		},
		rules: {
			eqeqeq: "error",
			quotes: ["error", "double"],
			"no-mixed-spaces-and-tabs": "off",
			"no-duplicate-imports": "error",
			// Honor the leading-underscore convention for intentionally-unused bindings,
			// matching TypeScript's own noUnusedLocals/noUnusedParameters behavior.
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					caughtErrorsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
					ignoreRestSiblings: true
				}
			]
		}
	}
])
