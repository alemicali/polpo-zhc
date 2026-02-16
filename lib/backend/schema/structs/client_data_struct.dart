// ignore_for_file: unnecessary_getters_setters
import '/backend/algolia/serialization_util.dart';
import 'package:cloud_firestore/cloud_firestore.dart';

import '/backend/schema/util/firestore_util.dart';

import '/flutter_flow/flutter_flow_util.dart';

class ClientDataStruct extends FFFirebaseStruct {
  ClientDataStruct({
    String? name,
    String? email,
    String? notes,
    String? roomNumber,
    DocumentReference? user,
    String? surname,
    DocumentReference? clientRef,
    FirestoreUtilData firestoreUtilData = const FirestoreUtilData(),
  })  : _name = name,
        _email = email,
        _notes = notes,
        _roomNumber = roomNumber,
        _user = user,
        _surname = surname,
        _clientRef = clientRef,
        super(firestoreUtilData);

  // "name" field.
  String? _name;
  String get name => _name ?? '';
  set name(String? val) => _name = val;

  bool hasName() => _name != null;

  // "email" field.
  String? _email;
  String get email => _email ?? '';
  set email(String? val) => _email = val;

  bool hasEmail() => _email != null;

  // "notes" field.
  String? _notes;
  String get notes => _notes ?? '';
  set notes(String? val) => _notes = val;

  bool hasNotes() => _notes != null;

  // "room_number" field.
  String? _roomNumber;
  String get roomNumber => _roomNumber ?? '';
  set roomNumber(String? val) => _roomNumber = val;

  bool hasRoomNumber() => _roomNumber != null;

  // "user" field.
  DocumentReference? _user;
  DocumentReference? get user => _user;
  set user(DocumentReference? val) => _user = val;

  bool hasUser() => _user != null;

  // "surname" field.
  String? _surname;
  String get surname => _surname ?? '';
  set surname(String? val) => _surname = val;

  bool hasSurname() => _surname != null;

  // "client_ref" field.
  DocumentReference? _clientRef;
  DocumentReference? get clientRef => _clientRef;
  set clientRef(DocumentReference? val) => _clientRef = val;

  bool hasClientRef() => _clientRef != null;

  static ClientDataStruct fromMap(Map<String, dynamic> data) =>
      ClientDataStruct(
        name: data['name'] as String?,
        email: data['email'] as String?,
        notes: data['notes'] as String?,
        roomNumber: data['room_number'] as String?,
        user: data['user'] as DocumentReference?,
        surname: data['surname'] as String?,
        clientRef: data['client_ref'] as DocumentReference?,
      );

  static ClientDataStruct? maybeFromMap(dynamic data) => data is Map
      ? ClientDataStruct.fromMap(data.cast<String, dynamic>())
      : null;

  Map<String, dynamic> toMap() => {
        'name': _name,
        'email': _email,
        'notes': _notes,
        'room_number': _roomNumber,
        'user': _user,
        'surname': _surname,
        'client_ref': _clientRef,
      }.withoutNulls;

  @override
  Map<String, dynamic> toSerializableMap() => {
        'name': serializeParam(
          _name,
          ParamType.String,
        ),
        'email': serializeParam(
          _email,
          ParamType.String,
        ),
        'notes': serializeParam(
          _notes,
          ParamType.String,
        ),
        'room_number': serializeParam(
          _roomNumber,
          ParamType.String,
        ),
        'user': serializeParam(
          _user,
          ParamType.DocumentReference,
        ),
        'surname': serializeParam(
          _surname,
          ParamType.String,
        ),
        'client_ref': serializeParam(
          _clientRef,
          ParamType.DocumentReference,
        ),
      }.withoutNulls;

  static ClientDataStruct fromSerializableMap(Map<String, dynamic> data) =>
      ClientDataStruct(
        name: deserializeParam(
          data['name'],
          ParamType.String,
          false,
        ),
        email: deserializeParam(
          data['email'],
          ParamType.String,
          false,
        ),
        notes: deserializeParam(
          data['notes'],
          ParamType.String,
          false,
        ),
        roomNumber: deserializeParam(
          data['room_number'],
          ParamType.String,
          false,
        ),
        user: deserializeParam(
          data['user'],
          ParamType.DocumentReference,
          false,
          collectionNamePath: ['users'],
        ),
        surname: deserializeParam(
          data['surname'],
          ParamType.String,
          false,
        ),
        clientRef: deserializeParam(
          data['client_ref'],
          ParamType.DocumentReference,
          false,
          collectionNamePath: ['clients'],
        ),
      );

  static ClientDataStruct fromAlgoliaData(Map<String, dynamic> data) =>
      ClientDataStruct(
        name: convertAlgoliaParam(
          data['name'],
          ParamType.String,
          false,
        ),
        email: convertAlgoliaParam(
          data['email'],
          ParamType.String,
          false,
        ),
        notes: convertAlgoliaParam(
          data['notes'],
          ParamType.String,
          false,
        ),
        roomNumber: convertAlgoliaParam(
          data['room_number'],
          ParamType.String,
          false,
        ),
        user: convertAlgoliaParam(
          data['user'],
          ParamType.DocumentReference,
          false,
        ),
        surname: convertAlgoliaParam(
          data['surname'],
          ParamType.String,
          false,
        ),
        clientRef: convertAlgoliaParam(
          data['client_ref'],
          ParamType.DocumentReference,
          false,
        ),
        firestoreUtilData: FirestoreUtilData(
          clearUnsetFields: false,
          create: true,
        ),
      );

  @override
  String toString() => 'ClientDataStruct(${toMap()})';

  @override
  bool operator ==(Object other) {
    return other is ClientDataStruct &&
        name == other.name &&
        email == other.email &&
        notes == other.notes &&
        roomNumber == other.roomNumber &&
        user == other.user &&
        surname == other.surname &&
        clientRef == other.clientRef;
  }

  @override
  int get hashCode => const ListEquality()
      .hash([name, email, notes, roomNumber, user, surname, clientRef]);
}

ClientDataStruct createClientDataStruct({
  String? name,
  String? email,
  String? notes,
  String? roomNumber,
  DocumentReference? user,
  String? surname,
  DocumentReference? clientRef,
  Map<String, dynamic> fieldValues = const {},
  bool clearUnsetFields = true,
  bool create = false,
  bool delete = false,
}) =>
    ClientDataStruct(
      name: name,
      email: email,
      notes: notes,
      roomNumber: roomNumber,
      user: user,
      surname: surname,
      clientRef: clientRef,
      firestoreUtilData: FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
        delete: delete,
        fieldValues: fieldValues,
      ),
    );

ClientDataStruct? updateClientDataStruct(
  ClientDataStruct? clientData, {
  bool clearUnsetFields = true,
  bool create = false,
}) =>
    clientData
      ?..firestoreUtilData = FirestoreUtilData(
        clearUnsetFields: clearUnsetFields,
        create: create,
      );

void addClientDataStructData(
  Map<String, dynamic> firestoreData,
  ClientDataStruct? clientData,
  String fieldName, [
  bool forFieldValue = false,
]) {
  firestoreData.remove(fieldName);
  if (clientData == null) {
    return;
  }
  if (clientData.firestoreUtilData.delete) {
    firestoreData[fieldName] = FieldValue.delete();
    return;
  }
  final clearFields =
      !forFieldValue && clientData.firestoreUtilData.clearUnsetFields;
  if (clearFields) {
    firestoreData[fieldName] = <String, dynamic>{};
  }
  final clientDataData = getClientDataFirestoreData(clientData, forFieldValue);
  final nestedData = clientDataData.map((k, v) => MapEntry('$fieldName.$k', v));

  final mergeFields = clientData.firestoreUtilData.create || clearFields;
  firestoreData
      .addAll(mergeFields ? mergeNestedFields(nestedData) : nestedData);
}

Map<String, dynamic> getClientDataFirestoreData(
  ClientDataStruct? clientData, [
  bool forFieldValue = false,
]) {
  if (clientData == null) {
    return {};
  }
  final firestoreData = mapToFirestore(clientData.toMap());

  // Add any Firestore field values
  clientData.firestoreUtilData.fieldValues
      .forEach((k, v) => firestoreData[k] = v);

  return forFieldValue ? mergeNestedFields(firestoreData) : firestoreData;
}

List<Map<String, dynamic>> getClientDataListFirestoreData(
  List<ClientDataStruct>? clientDatas,
) =>
    clientDatas?.map((e) => getClientDataFirestoreData(e, true)).toList() ?? [];
