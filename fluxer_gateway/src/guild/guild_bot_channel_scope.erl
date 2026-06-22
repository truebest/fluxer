%% SPDX-License-Identifier: AGPL-3.0-or-later

-module(guild_bot_channel_scope).
-typing([eqwalizer]).

-export([
    allows/4,
    allows_from_index/4,
    cache_key/3,
    has_scope/2,
    index/1
]).

-type user_id() :: integer().
-type channel_id() :: integer().
-type guild_state() :: map().
-type member() :: map() | undefined.

-export_type([user_id/0, channel_id/0, guild_state/0]).

-spec allows(user_id(), channel_id(), member(), guild_state()) -> boolean().
allows(UserId, ChannelId, Member, State) when
    is_integer(UserId), UserId > 0, is_integer(ChannelId), ChannelId > 0
->
    ResolvedMember = resolve_member(Member, UserId, State),
    case member_is_bot(ResolvedMember) of
        false ->
            true;
        true ->
            scope_allows(UserId, ChannelId, index(State))
    end;
allows(_UserId, _ChannelId, _Member, _State) ->
    true.

-spec allows_from_index(user_id(), channel_id(), member(), map()) -> boolean().
allows_from_index(UserId, ChannelId, Member, ScopeIndex) when
    is_integer(UserId), UserId > 0, is_integer(ChannelId), ChannelId > 0
->
    case member_is_bot(Member) of
        false -> true;
        true -> scope_allows(UserId, ChannelId, ScopeIndex)
    end;
allows_from_index(_UserId, _ChannelId, _Member, _ScopeIndex) ->
    true.

-spec cache_key(user_id(), term(), guild_state()) -> term().
cache_key(UserId, RoleKey, State) ->
    case has_scope(UserId, State) of
        true -> {bot_channel_scope, UserId, RoleKey};
        false -> {roles, RoleKey}
    end.

-spec has_scope(user_id(), guild_state()) -> boolean().
has_scope(UserId, State) when is_integer(UserId), UserId > 0 ->
    maps:is_key(UserId, index(State));
has_scope(_UserId, _State) ->
    false.

-spec index(guild_state()) -> map().
index(#{data := Data}) when is_map(Data) ->
    index(Data);
index(Data) when is_map(Data) ->
    Scopes = map_utils:ensure_list(maps:get(<<"bot_channel_scopes">>, Data, [])),
    lists:foldl(fun add_scope/2, #{}, Scopes);
index(_State) ->
    #{}.

-spec scope_allows(user_id(), channel_id(), map()) -> boolean().
scope_allows(UserId, ChannelId, ScopeIndex) ->
    case maps:get(UserId, ScopeIndex, undefined) of
        undefined -> true;
        ChannelIds when is_map(ChannelIds) -> maps:is_key(ChannelId, ChannelIds);
        _ -> false
    end.

-spec member_is_bot(member()) -> boolean().
member_is_bot(Member) when is_map(Member) ->
    User = maps:get(<<"user">>, Member, #{}),
    maps:get(<<"bot">>, User, false) =:= true;
member_is_bot(_Member) ->
    false.

-spec resolve_member(member(), user_id(), guild_state()) -> member().
resolve_member(Member, _UserId, _State) when is_map(Member) ->
    Member;
resolve_member(_Member, UserId, State) ->
    guild_permissions:find_member_by_user_id(UserId, State).

-spec add_scope(term(), map()) -> map().
add_scope(Scope, Acc) when is_map(Scope) ->
    BotUserId = snowflake_id:parse_maybe(maps:get(<<"bot_user_id">>, Scope, undefined)),
    case BotUserId of
        undefined ->
            Acc;
        _ ->
            Acc#{BotUserId => channel_id_map(maps:get(<<"channel_ids">>, Scope, []))}
    end;
add_scope(_Scope, Acc) ->
    Acc.

-spec channel_id_map(term()) -> map().
channel_id_map(ChannelIds) ->
    lists:foldl(fun add_channel_id/2, #{}, map_utils:ensure_list(ChannelIds)).

-spec add_channel_id(term(), map()) -> map().
add_channel_id(ChannelId, Acc) ->
    case snowflake_id:parse_maybe(ChannelId) of
        undefined -> Acc;
        Parsed -> Acc#{Parsed => true}
    end.

-ifdef(TEST).
-include_lib("eunit/include/eunit.hrl").

allows_unscoped_bot_test() ->
    State = #{data => #{<<"bot_channel_scopes">> => []}},
    Member = #{<<"user">> => #{<<"bot">> => true}},
    ?assertEqual(true, allows(10, 100, Member, State)).

allows_scoped_bot_channel_test() ->
    State = #{
        data => #{
            <<"bot_channel_scopes">> => [
                #{<<"bot_user_id">> => <<"10">>, <<"channel_ids">> => [<<"100">>]}
            ]
        }
    },
    Member = #{<<"user">> => #{<<"bot">> => true}},
    ?assertEqual(true, allows(10, 100, Member, State)),
    ?assertEqual(false, allows(10, 101, Member, State)).

allows_non_bot_test() ->
    State = #{
        data => #{
            <<"bot_channel_scopes">> => [
                #{<<"bot_user_id">> => <<"10">>, <<"channel_ids">> => []}
            ]
        }
    },
    Member = #{<<"user">> => #{<<"bot">> => false}},
    ?assertEqual(true, allows(10, 101, Member, State)).

cache_key_scoped_bot_is_user_specific_test() ->
    State = #{
        data => #{
            <<"bot_channel_scopes">> => [
                #{<<"bot_user_id">> => <<"10">>, <<"channel_ids">> => [<<"100">>]}
            ]
        }
    },
    ?assertEqual({bot_channel_scope, 10, {1, 2}}, cache_key(10, {1, 2}, State)),
    ?assertEqual({roles, {1, 2}}, cache_key(11, {1, 2}, State)).

-endif.
