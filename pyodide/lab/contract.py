

def check(condition, message):
    if not condition:
        raise AssertionError(message)


def accept_fixture(reply, run_id, active):
    if not active or type(reply) is not dict:
        return False
    if set(reply) != {"run_id", "status", "value"}:
        return False
    if reply["run_id"] != run_id or reply["status"] != "result":
        return False
    value = reply["value"]
    if type(value) is not dict or set(value) != {"count", "sum"}:
        return False
    if type(value["count"]) is not int or type(value["sum"]) is not int:
        return False
    return value == {"count": 3, "sum": 10}
