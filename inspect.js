import { inspect as _inspect } from "node:util";

const inspect = ({ message = "", value, options = {} }) => {
  console.log("=========");
  console.log(
    message,
    "\n",
    _inspect(value, {
      showHidden: false,
      depth: null,
      colors: true,
      ...options,
    }),
  );
};

export { inspect };
