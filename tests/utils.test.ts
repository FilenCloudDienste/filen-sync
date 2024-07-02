import { replacePathStartWithFromAndTo } from "../src/utils"

test("replacePathStartWithFromAndTo basic", () => {
	const path = "/foo/bar"
	const from = "/foo"
	const to = "/baz"

	expect(replacePathStartWithFromAndTo(path, from, to)).toBe("/baz/bar")
})

test("replacePathStartWithFromAndTo basic + extension", () => {
	const path = "/foo/bar.txt"
	const from = "/foo"
	const to = "/baz"

	expect(replacePathStartWithFromAndTo(path, from, to)).toBe("/baz/bar.txt")
})

test("replacePathStartWithFromAndTo same names", () => {
	const path = "/1/1/1/1"
	const from = "/1"
	const to = "/2"

	expect(replacePathStartWithFromAndTo(path, from, to)).toBe("/2/1/1/1")
})

test("replacePathStartWithFromAndTo same names + extension", () => {
	const path = "/1/1/1/1.txt"
	const from = "/1"
	const to = "/2"

	expect(replacePathStartWithFromAndTo(path, from, to)).toBe("/2/1/1/1.txt")
})
