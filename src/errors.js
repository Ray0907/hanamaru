export class HanamaruError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = new.target.name;
    this.code = code;

    if (arguments.length === 3) {
      this.details = details;
    }
  }
}

export class HanamaruTargetError extends HanamaruError {}

export class HanamaruConfigError extends HanamaruError {}

export class HanamaruStateError extends HanamaruError {}
