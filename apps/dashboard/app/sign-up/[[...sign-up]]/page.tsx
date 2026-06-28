import { SignUp } from "@clerk/nextjs"

const wrap = { display: "flex", justifyContent: "center", padding: "64px 16px" }

export default function SignUpPage() {
	return (
		<div style={wrap}>
			<SignUp />
		</div>
	)
}
